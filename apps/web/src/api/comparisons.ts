import { comparisonResponseSchema, publicErrorSchema, decodeNdjson, streamEventSchema, utf8Bytes } from '@llm-compare/contracts';
import type { ComparisonRequest, RetryRequest, StreamEvent, AttemptResult } from '@llm-compare/contracts';

export async function sendComparison(
  input: ComparisonRequest | RetryRequest,
  signal: AbortSignal,
  onEvent?: (event: StreamEvent) => void,
) {
  const transportSignal = AbortSignal.any([signal, AbortSignal.timeout(140_000)]);
  const response = await fetch('targets' in input ? '/api/comparisons' : '/api/retries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(onEvent ? { Accept: 'application/x-ndjson' } : {}) },
    body: JSON.stringify(input),
    signal: transportSignal,
  });
  if (response.ok && response.headers.get('content-type')?.includes('application/x-ndjson') && response.body) {
    const targets = 'targets' in input ? input.targets : [input.target];
    const results = new Map<string, AttemptResult>();
    const started = new Set<string>();
    const texts = new Map<string, string>();
    const sizes = new Map<string, number>();
    let seq = 0;
    let runStarted = false;
    let completed = false;
    for await (const raw of decodeNdjson(response.body, transportSignal)) {
      const event = streamEventSchema.parse(raw);
      if (event.runId !== input.runId || event.turnId !== input.turnId) throw new Error('Поток не соответствует сравнению.');
      if (event.seq <= seq) continue;
      if (event.seq !== seq + 1 || completed) throw new Error('Нарушена последовательность потока.');
      seq = event.seq;
      if (event.type === 'run_started') {
        if (runStarted) throw new Error('Повторное начало потока.');
        runStarted = true;
      } else {
        if (!runStarted) throw new Error('Отсутствует начало потока.');
        if (event.type === 'run_completed') {
          if (results.size !== targets.length) throw new Error('Поток завершён без всех результатов.');
          completed = true;
        } else {
          const identity = event.type === 'model_result' ? event.result : event;
          const target = targets.find((item) => item.columnId === identity.columnId && item.attemptId === identity.attemptId && item.modelId === identity.modelId);
          if (!target || results.has(identity.columnId)) throw new Error('Попытка потока не соответствует сравнению.');
          if (event.type === 'model_started') {
            if (started.has(event.columnId)) throw new Error('Повторное начало попытки.');
            started.add(event.columnId);
          } else {
            if (!started.has(identity.columnId)) throw new Error('Отсутствует начало попытки.');
            if (event.type === 'answer_delta') {
              const text = (texts.get(event.columnId) ?? '') + event.text;
              const size = (sizes.get(event.columnId) ?? 0) + utf8Bytes(event.text);
              if (size > 512 * 1024) throw new Error('Ответ слишком велик.');
              sizes.set(event.columnId, size);
              texts.set(event.columnId, text);
            } else {
              if (event.result.text !== (texts.get(identity.columnId) ?? '')) throw new Error('Текст результата не соответствует потоку.');
              results.set(event.result.columnId, event.result);
            }
          }
        }
      }
      onEvent?.(event);
      if (completed) break;
    }
    if (!completed) throw new Error('Соединение прервано до завершения ответов.');
    return comparisonResponseSchema.parse({ protocolVersion: 1, conversationId: input.conversationId, runId: input.runId, turnId: input.turnId, results: [...results.values()] });
  }
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
