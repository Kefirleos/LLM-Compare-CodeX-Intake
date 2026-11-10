import { utf8Bytes } from '@llm-compare/contracts';
import type { AttemptResult, ComparisonTarget, StreamEvent } from '@llm-compare/contracts';
import type { LlmAdapter } from '../adapters/types.js';
import { AdapterError } from '../adapters/error.js';
import { DeadlineError, withDeadline } from './deadline.js';

export type OutgoingEvent = StreamEvent extends infer E ? E extends StreamEvent ? Omit<E, 'v' | 'runId' | 'turnId' | 'seq'> : never : never;

export async function streamComparison(adapter: LlmAdapter, prompt: string, targets: ComparisonTarget[],
  signal: AbortSignal, timeoutMs: number, emit: (event: OutgoingEvent) => Promise<void>) {
  await emit({ type: 'run_started' });
  await Promise.all(targets.map(async (target) => {
    const identity = { columnId: target.columnId, attemptId: target.attemptId, modelId: target.modelId };
    const started = performance.now();
    let text = '';
    let size = 0;
    let result: AttemptResult;
    try {
      await withDeadline(async (attemptSignal) => {
        await emit({ type: 'model_started', ...identity });
        const append = async (delta: string) => {
          attemptSignal.throwIfAborted();
          size += utf8Bytes(delta);
          if (size > 512 * 1024) throw new AdapterError({ code: 'OUTPUT_LIMIT', message: 'Ответ превышает допустимый размер.', retryable: false });
          text += delta;
          await emit({ type: 'answer_delta', ...identity, text: delta });
        };
        if (adapter.stream) {
          for await (const delta of adapter.stream({ modelId: target.modelId, prompt }, attemptSignal)) await append(delta);
        } else {
          await append((await adapter.generate({ modelId: target.modelId, prompt }, attemptSignal)).text);
        }
      }, signal, timeoutMs);
      result = { ...identity, text, status: 'succeeded', totalMs: performance.now() - started, error: null };
    } catch (error) {
      const status = signal.aborted ? 'cancelled' : error instanceof DeadlineError ? 'timed_out' : 'failed';
      result = { ...identity, text, status, totalMs: performance.now() - started, error:
        status === 'cancelled' ? { code: 'CANCELLED', message: 'Запрос остановлен.', retryable: true }
          : status === 'timed_out' ? { code: 'TIMEOUT', message: 'Модель не ответила вовремя.', retryable: true }
            : error instanceof AdapterError ? error.publicError
              : { code: 'GENERATION_FAILED', message: 'Не удалось получить ответ модели.', retryable: true } };
    }
    if (!signal.aborted) await emit({ type: 'model_result', result });
  }));
  if (!signal.aborted) await emit({ type: 'run_completed' });
}
