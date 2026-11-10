import { utf8Bytes } from '@llm-compare/contracts';
import type { AttemptResult, ComparisonTarget, PublicError } from '@llm-compare/contracts';
import type { LlmAdapter } from '../adapters/types.js';
import { DeadlineError, withDeadline } from './deadline.js';
import { AdapterError } from '../adapters/error.js';

export async function runComparison(
  adapter: LlmAdapter,
  prompt: string,
  targets: readonly ComparisonTarget[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<AttemptResult[]> {
  return Promise.all(targets.map(async (target): Promise<AttemptResult> => {
    let startedAt = performance.now();
    const identity = { columnId: target.columnId, attemptId: target.attemptId, modelId: target.modelId };
    const elapsed = () => Math.max(0, performance.now() - startedAt);
    const metrics = { firstEventMs: null, firstAnswerMs: null, inputTokens: null, outputTokens: null, cost: null };
    try {
      const result = await withDeadline(
        (attemptSignal) => {
          startedAt = performance.now();
          return adapter.generate({ modelId: target.modelId, prompt, ...(target.history.length ? { history: target.history } : {}) }, attemptSignal);
        },
        signal, timeoutMs,
      );
      if (typeof result.text !== 'string' || utf8Bytes(result.text) > 512 * 1024) {
        return { ...identity, metrics, totalMs: elapsed(), status: 'failed', text: '', error: {
          code: 'OUTPUT_LIMIT', message: 'Ответ превышает допустимый размер или имеет неверный формат.', retryable: false,
        } };
      }
      return { ...identity, metrics, totalMs: elapsed(), status: 'succeeded', text: result.text, error: null };
    } catch (error) {
      let status: 'failed' | 'timed_out' | 'cancelled' = 'failed';
      let publicError: PublicError = { code: 'GENERATION_FAILED', message: 'Не удалось получить ответ модели.', retryable: true };
      if (error instanceof DeadlineError) {
        status = 'timed_out';
        publicError = { code: 'TIMEOUT', message: 'Модель не ответила вовремя.', retryable: true };
      } else if (signal.aborted) {
        status = 'cancelled';
        publicError = { code: 'CANCELLED', message: 'Запрос прерван.', retryable: true };
      } else if (error instanceof AdapterError) {
        publicError = error.publicError;
      }
      return { ...identity, metrics, totalMs: elapsed(), status, text: '', error: publicError };
    }
  }));
}
