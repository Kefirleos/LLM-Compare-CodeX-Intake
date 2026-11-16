import { utf8Bytes } from '@llm-compare/contracts';
import type { AttemptMetrics, AttemptResult, ComparisonTarget, StreamEvent } from '@llm-compare/contracts';
import type { LlmAdapter } from '../adapters/types.js';
import { AdapterError } from '../adapters/error.js';
import { DeadlineError, withDeadline, withStreamDeadline, defaultStreamTimeouts } from './deadline.js';
import type { ActivityClock, StreamTimeouts } from './deadline.js';

export type OutgoingEvent = StreamEvent extends infer E ? E extends StreamEvent ? Omit<E, 'v' | 'runId' | 'turnId' | 'seq'> : never : never;

export async function streamComparison(adapter: LlmAdapter, prompt: string, targets: ComparisonTarget[],
  signal: AbortSignal, timeoutMs: number, emit: (event: OutgoingEvent) => Promise<void>, timeouts: StreamTimeouts = defaultStreamTimeouts) {
  await emit({ type: 'run_started' });
  await Promise.all(targets.map(async (target) => {
    const identity = { columnId: target.columnId, attemptId: target.attemptId, modelId: target.modelId };
    let started = performance.now();
    const metrics: AttemptMetrics = { firstEventMs: null, firstAnswerMs: null, inputTokens: null, outputTokens: null, cost: null };
    const observe = (answer: boolean) => {
      const elapsed = Math.max(0, performance.now() - started);
      metrics.firstEventMs ??= elapsed;
      if (answer) metrics.firstAnswerMs ??= elapsed;
    };
    let text = '';
    let reasoning = '';
    let reasoningStartedAt: number | null = null;
    let reasoningMs = 0;
    const closeReasoning = () => {
      if (reasoningStartedAt !== null) reasoningMs += performance.now() - reasoningStartedAt;
      reasoningStartedAt = null;
    };
    const reasoningResult = () => {
      closeReasoning();
      return reasoning || reasoningMs > 0 ? { reasoning, reasoningMs } : {};
    };
    let size = 0;
    let result: AttemptResult;
    try {
      const operation = async (attemptSignal: AbortSignal, clock?: ActivityClock) => {
        const publish = async (event: OutgoingEvent, onEnqueued?: () => void) => {
          attemptSignal.throwIfAborted();
          clock?.pause();
          try {
            const writing = emit(event);
            // Admission can reject synchronously. Once enqueued, terminal text must include the
            // frame even if the attempt times out before the socket drains.
            onEnqueued?.();
            await writing;
          } finally { clock?.resume(); }
        };
        await publish({ type: 'model_started', ...identity });
        started = performance.now();
        const append = async (delta: string) => {
          attemptSignal.throwIfAborted();
          if (!delta.length) return;
          if (adapter.stream) observe(true);
          clock?.activity();
          if (reasoningStartedAt !== null) { closeReasoning(); await publish({ type: 'reasoning_ended', ...identity }); }
          attemptSignal.throwIfAborted();
          const nextSize = size + utf8Bytes(delta);
          if (nextSize > 512 * 1024) throw new AdapterError({ code: 'OUTPUT_LIMIT', message: 'Ответ превышает допустимый размер.', retryable: false });
          await publish({ type: 'answer_delta', ...identity, text: delta }, () => { size = nextSize; text += delta; });
        };
        const prepared = { modelId: target.modelId, prompt, ...(target.history.length ? { history: target.history } : {}) };
        if (adapter.stream) {
          for await (const chunk of adapter.stream(prepared, attemptSignal, clock?.activity)) {
            attemptSignal.throwIfAborted();
            if (typeof chunk === 'string') { await append(chunk); continue; }
            if (chunk.type === 'reasoning_ended') {
              if (reasoningStartedAt !== null) { closeReasoning(); await publish({ type: 'reasoning_ended', ...identity }); }
              continue;
            }
            if (chunk.type === 'reasoning_delta' && !chunk.text.length) continue;
            if (chunk.type === 'reasoning_delta') observe(false);
            if (reasoningStartedAt === null) { reasoningStartedAt = performance.now(); await publish({ type: 'reasoning_started', ...identity }); }
            attemptSignal.throwIfAborted();
            if (chunk.type === 'reasoning_delta') {
              clock?.activity();
              const nextSize = size + utf8Bytes(chunk.text);
              if (nextSize > 512 * 1024) throw new AdapterError({ code: 'OUTPUT_LIMIT', message: 'Ответ и Thinking превышают допустимый размер.', retryable: false });
              await publish({ type: 'reasoning_delta', ...identity, text: chunk.text }, () => { size = nextSize; reasoning += chunk.text; });
            }
          }
        } else {
          await append((await adapter.generate(prepared, attemptSignal)).text);
        }
      };
      if (adapter.stream) await withStreamDeadline(operation, signal, timeoutMs, timeouts);
      else await withDeadline(operation, signal, timeoutMs);
      result = { ...identity, text, metrics: { ...metrics }, ...reasoningResult(), status: 'succeeded', totalMs: performance.now() - started, error: null };
    } catch (error) {
      const status = signal.aborted ? 'cancelled' : error instanceof DeadlineError ? 'timed_out' : 'failed';
      result = { ...identity, text, metrics: { ...metrics }, ...reasoningResult(), status, totalMs: performance.now() - started, error:
        status === 'cancelled' ? { code: 'CANCELLED', message: 'Запрос остановлен.', retryable: true }
          : status === 'timed_out' ? { code: 'TIMEOUT', message: error instanceof DeadlineError && error.reason === 'first_data' ? 'Модель не начала ответ вовремя.'
            : error instanceof DeadlineError && error.reason === 'idle' ? 'Модель слишком долго не присылает данные.' : 'Превышено общее время ответа модели.', retryable: true }
            : error instanceof AdapterError ? error.publicError
              : { code: 'GENERATION_FAILED', message: 'Не удалось получить ответ модели.', retryable: true } };
    }
    if (!signal.aborted) await emit({ type: 'model_result', result });
  }));
  if (!signal.aborted) await emit({ type: 'run_completed' });
}
