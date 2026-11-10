import { utf8Bytes } from '@llm-compare/contracts';
import type { AttemptResult, ComparisonTarget, StreamEvent } from '@llm-compare/contracts';
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
    const started = performance.now();
    let text = '';
    let size = 0;
    let result: AttemptResult;
    try {
      const operation = async (attemptSignal: AbortSignal, clock?: ActivityClock) => {
        const publish = async (event: OutgoingEvent) => {
          attemptSignal.throwIfAborted();
          clock?.pause();
          try { await emit(event); } finally { clock?.resume(); }
        };
        await publish({ type: 'model_started', ...identity });
        const append = async (delta: string) => {
          attemptSignal.throwIfAborted();
          if (!delta.length) return;
          clock?.activity();
          size += utf8Bytes(delta);
          if (size > 512 * 1024) throw new AdapterError({ code: 'OUTPUT_LIMIT', message: 'Ответ превышает допустимый размер.', retryable: false });
          text += delta;
          await publish({ type: 'answer_delta', ...identity, text: delta });
        };
        if (adapter.stream) {
          for await (const delta of adapter.stream({ modelId: target.modelId, prompt }, attemptSignal, clock?.activity)) await append(delta);
        } else {
          await append((await adapter.generate({ modelId: target.modelId, prompt }, attemptSignal)).text);
        }
      };
      if (adapter.stream) await withStreamDeadline(operation, signal, timeoutMs, timeouts);
      else await withDeadline(operation, signal, timeoutMs);
      result = { ...identity, text, status: 'succeeded', totalMs: performance.now() - started, error: null };
    } catch (error) {
      const status = signal.aborted ? 'cancelled' : error instanceof DeadlineError ? 'timed_out' : 'failed';
      result = { ...identity, text, status, totalMs: performance.now() - started, error:
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
