import { comparisonResponseSchema, publicErrorSchema } from '@llm-compare/contracts';
import type { ComparisonRequest, RetryRequest } from '@llm-compare/contracts';

export async function sendComparison(
  input: ComparisonRequest | RetryRequest,
  signal: AbortSignal,
) {
  const response = await fetch('targets' in input ? '/api/comparisons' : '/api/retries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Сервер вернул неожиданный формат ответа.');
  }
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = publicErrorSchema.safeParse(body);
    throw new Error(error.success ? error.data.message : 'Не удалось запустить сравнение.');
  }
  const result = comparisonResponseSchema.parse(body);
  const targets = 'targets' in input ? input.targets : [input.target];
  if (result.runId !== input.runId || result.turnId !== input.turnId || result.conversationId !== input.conversationId
    || result.results.length !== targets.length
    || new Set(result.results.map((item) => item.columnId)).size !== targets.length
    || targets.some((target) => !result.results.some((item) => item.columnId === target.columnId
      && item.attemptId === target.attemptId && item.modelId === target.modelId))) {
    throw new Error('Ответ сервера не соответствует текущему сравнению.');
  }
  return result;
}
