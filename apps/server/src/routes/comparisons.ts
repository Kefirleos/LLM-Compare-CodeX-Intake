import type { FastifyInstance } from 'fastify';
import { MAX_NDJSON_LINE_BYTES, MAX_NDJSON_STREAM_BYTES, comparisonRequestSchema, comparisonResponseSchema, retryRequestSchema } from '@llm-compare/contracts';
import type { ComparisonTarget } from '@llm-compare/contracts';
import type { LlmAdapter } from '../adapters/types.js';
import { runComparison } from '../generation/runner.js';
import { AdapterError } from '../adapters/error.js';
import type { CatalogService } from '../catalog/service.js';
import { streamComparison } from '../generation/stream.js';
import type { OutgoingEvent } from '../generation/stream.js';
import type { StreamTimeouts } from '../generation/deadline.js';

export function registerComparisons(app: FastifyInstance, adapter: LlmAdapter, timeoutMs: number, catalogs: CatalogService, streamTimeouts: StreamTimeouts) {
  // Bounded, process-local duplicate protection; no prompt or answer storage.
  const runs = new Map<string, { expiresAt: number; active: boolean }>();
  const controllers = new Set<AbortController>();
  let activeAttempts = 0;
  app.addHook('preClose', async () => {
    for (const controller of controllers) controller.abort();
  });

  for (const url of ['/api/comparisons', '/api/retries']) {
    app.post(url, async (request, reply) => {
      const parsed = url === '/api/comparisons'
        ? comparisonRequestSchema.safeParse(request.body)
        : retryRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({
        code: 'INVALID_REQUEST', message: 'Проверьте вопрос и выбранные модели.', retryable: false,
      });
      const input = parsed.data;
      const targets: ComparisonTarget[] = 'targets' in input ? input.targets : [input.target];
      const now = Date.now();
      for (const [id, run] of runs) if (!run.active && run.expiresAt <= now) runs.delete(id);
      if (runs.has(input.runId)) return reply.code(409).send({
        code: 'RUN_CONFLICT', message: 'Этот запрос уже был принят. Автоматический повтор отключён.', retryable: false,
      });
      if (runs.size >= 256 || activeAttempts + targets.length > 8) return reply.code(429).send({
        code: 'BUSY', message: 'Сервер занят. Повторите запрос позже.', retryable: true,
      });

      // Reserve the complete run before any asynchronous validation or generation.
      runs.set(input.runId, { active: true, expiresAt: now + 5 * 60_000 });
      activeAttempts += targets.length;
      const controller = new AbortController();
      controllers.add(controller);
      const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.once('close', onClose);
      let accepted = false;
      try {
        let catalog;
        try {
          catalog = (await catalogs.get(controller.signal)).models;
        } catch (error) {
          if (error instanceof AdapterError) return reply.code(503).send(error.publicError);
          return reply.code(503).send({ code: 'CATALOG_UNAVAILABLE', message: 'Не удалось проверить каталог моделей.', retryable: true });
        }
        const allowed = new Map(catalog.map((model) => [model.id, model.pricing]));
        if (targets.some((target) => !allowed.has(target.modelId))) return reply.code(422).send({
          code: 'MODEL_UNAVAILABLE', message: 'Одна из моделей недоступна. Обновите каталог.', retryable: false,
        });
        const pricedTargets = targets.map((target) => ({ ...target, pricing: allowed.get(target.modelId) ?? null }));
        accepted = true;
        if (request.headers.accept === 'application/x-ndjson') {
          reply.hijack();
          reply.raw.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no',
          });
          reply.raw.flushHeaders();
          const frame = (event: OutgoingEvent, seq: number) => JSON.stringify({ v: 1, runId: input.runId, turnId: input.turnId, seq, ...event }) + '\n';
          // The complete result repeats previously sent text. Reserve a whole line per terminal,
          // plus the longest two control frames, before sharing the remaining bytes across models.
          const controlBytes = Buffer.byteLength(frame({ type: 'run_started' }, Number.MAX_SAFE_INTEGER))
            + Buffer.byteLength(frame({ type: 'run_completed' }, Number.MAX_SAFE_INTEGER));
          const bytesPerAttempt = Math.floor((MAX_NDJSON_STREAM_BYTES - controlBytes) / targets.length) - (MAX_NDJSON_LINE_BYTES + 1);
          const used = new Map<string, number>();
          let seq = 0;
          let queue = Promise.resolve();
          const emit = (event: OutgoingEvent) => {
            controller.signal.throwIfAborted();
            const record = frame(event, seq + 1);
            const length = Buffer.byteLength(record);
            if ('columnId' in event) {
              const next = (used.get(event.columnId) ?? 0) + length;
              if (next > bytesPerAttempt || length > MAX_NDJSON_LINE_BYTES + 1) {
                throw new AdapterError({ code: 'OUTPUT_LIMIT', message: 'Поток модели содержит слишком много данных.', retryable: false });
              }
              used.set(event.columnId, next);
            } else if (length > MAX_NDJSON_LINE_BYTES + 1) {
              throw new Error('Terminal record exceeds NDJSON line limit');
            }
            seq++;
            // Each producer awaits its write: at most four pending records, no unbounded queue.
            queue = queue.then(async () => {
              controller.signal.throwIfAborted();
              if (reply.raw.write(record)) return;
              await new Promise<void>((resolve, reject) => {
                const cleanup = () => { clearTimeout(timer); reply.raw.off('drain', drain); controller.signal.removeEventListener('abort', abort); };
                const drain = () => { cleanup(); resolve(); };
                const abort = () => {
                  cleanup();
                  // A graceful end would wait for the stalled socket to flush its buffer.
                  reply.raw.destroy();
                  reject(new Error('Stream closed'));
                };
                const timer = setTimeout(() => { controller.abort(); }, 5000);
                reply.raw.once('drain', drain);
                controller.signal.addEventListener('abort', abort, { once: true });
                if (controller.signal.aborted) abort();
              });
            });
            return queue;
          };
          try {
            await streamComparison(adapter, input.prompt, pricedTargets, controller.signal, timeoutMs, emit, streamTimeouts);
          } catch {
            controller.abort();
          } finally {
            if (!reply.raw.destroyed) reply.raw.end();
          }
          return;
        }
        const results = await runComparison(adapter, input.prompt, pricedTargets, controller.signal, timeoutMs);
        return comparisonResponseSchema.parse({
          protocolVersion: 1, conversationId: input.conversationId, runId: input.runId, turnId: input.turnId, results,
        });
      } finally {
        controllers.delete(controller);
        activeAttempts -= targets.length;
        reply.raw.removeListener('close', onClose);
        if (accepted) runs.set(input.runId, { active: false, expiresAt: Date.now() + 5 * 60_000 });
        else runs.delete(input.runId);
      }
    });
  }
}
