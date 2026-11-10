import { z } from 'zod';

export const capabilitySchema = z.enum(['supported', 'unsupported', 'unknown']);

export const modelDescriptorSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.string().min(1),
  capabilities: z.strictObject({
    streaming: capabilitySchema,
    reasoning: capabilitySchema,
  }),
  pricing: z.strictObject({
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
    currency: z.literal('USD'),
  }).nullable(),
  metadataSource: z.enum(['mock', 'upstream', 'curated']),
});

export const modelCatalogSchema = z.strictObject({
  protocolVersion: z.literal(1),
  catalogVersion: z.string().min(1),
  mode: z.enum(['mock', 'live']),
  models: z.array(modelDescriptorSchema),
});

export const healthSchema = z.strictObject({ status: z.literal('ok') });

export const publicErrorSchema = z.strictObject({
  code: z.enum([
    'CATALOG_UNAVAILABLE', 'INTERNAL_ERROR', 'NOT_FOUND', 'INVALID_REQUEST',
    'MODEL_UNAVAILABLE', 'RUN_CONFLICT', 'BUSY', 'PAYLOAD_TOO_LARGE',
    'GENERATION_FAILED', 'TIMEOUT', 'CANCELLED', 'OUTPUT_LIMIT',
    'UPSTREAM_AUTH', 'UPSTREAM_RATE_LIMIT', 'UPSTREAM_PROTOCOL', 'UPSTREAM_UNAVAILABLE',
  ]),
  message: z.string(),
  retryable: z.boolean(),
});

export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export const MAX_PROMPT_BYTES = 16 * 1024;
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
export const MAX_CONTEXT_BYTES = 64 * 1024;
export const historyPairSchema = z.strictObject({ user: z.string().min(1).max(MAX_PROMPT_BYTES), assistant: z.string().max(512 * 1024) });
export type HistoryPair = z.infer<typeof historyPairSchema>;
export function serializePrompt(prompt: string, history: readonly HistoryPair[]): string {
  if (!history.length) return prompt;
  return 'Продолжи диалог. Ниже JSON с завершёнными парами user/assistant и текущим question. Ответь на question с учётом history.\n'
    + JSON.stringify({ version: 1, history, question: prompt });
}

const promptSchema = z.string().max(MAX_PROMPT_BYTES)
  .refine((value) => value.trim().length > 0, 'Введите вопрос.')
  .refine((value) => utf8Bytes(value) <= MAX_PROMPT_BYTES, 'Вопрос превышает 16 КиБ.');

export const comparisonTargetSchema = z.strictObject({
  columnId: z.uuid(),
  modelId: z.string().min(1).max(256),
  attemptId: z.uuid(),
  history: z.array(historyPairSchema).max(16),
});

const requestFields = {
  protocolVersion: z.literal(1),
  conversationId: z.uuid(),
  runId: z.uuid(),
  turnId: z.uuid(),
  prompt: promptSchema,
  serializerVersion: z.literal(1).optional(),
};

function contextFits(prompt: string, target: { history: HistoryPair[] }) {
  return utf8Bytes(serializePrompt(prompt, target.history)) <= MAX_CONTEXT_BYTES;
}

export const comparisonRequestSchema = z.strictObject({
  ...requestFields,
  targets: z.array(comparisonTargetSchema).min(2).max(4),
}).superRefine(({ targets, prompt }, context) => {
  if (targets.some((target) => !contextFits(prompt, target))) context.addIssue({ code: 'custom', path: ['targets'], message: 'Контекст превышает 64 КиБ. Начните новое сравнение.' });
  for (const field of ['columnId', 'modelId', 'attemptId'] as const) {
    if (new Set(targets.map((target) => target[field])).size !== targets.length) {
      context.addIssue({ code: 'custom', path: ['targets'], message: `Duplicate ${field}` });
    }
  }
});

export const retryRequestSchema = z.strictObject({
  ...requestFields,
  target: comparisonTargetSchema,
}).refine(({ prompt, target }) => contextFits(prompt, target), 'Контекст превышает 64 КиБ. Начните новое сравнение.');

export const attemptMetricsSchema = z.strictObject({
  firstEventMs: z.number().nonnegative().nullable(),
  firstAnswerMs: z.number().nonnegative().nullable(),
  inputTokens: z.null(),
  outputTokens: z.null(),
  cost: z.null(),
}).refine(({ firstEventMs, firstAnswerMs }) => firstAnswerMs === null || (firstEventMs !== null && firstEventMs <= firstAnswerMs), 'Первый ответ не может предшествовать первым данным.');
export type AttemptMetrics = z.infer<typeof attemptMetricsSchema>;

const resultFields = {
  columnId: z.uuid(),
  attemptId: z.uuid(),
  modelId: z.string(),
  totalMs: z.number().nonnegative(),
  reasoning: z.string().optional(),
  reasoningMs: z.number().nonnegative().optional(),
  metrics: attemptMetricsSchema.optional(),
};

export const attemptResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...resultFields, status: z.literal('succeeded'), text: z.string(), error: z.null() }),
  z.strictObject({
    ...resultFields,
    status: z.enum(['failed', 'timed_out', 'cancelled']),
    text: z.string(),
    error: publicErrorSchema,
  }),
]).refine((result) => !result.metrics || ((result.metrics.firstEventMs === null || result.metrics.firstEventMs <= result.totalMs)
  && (result.metrics.firstAnswerMs === null || result.metrics.firstAnswerMs <= result.totalMs)), 'Время первого фрагмента превышает полное время попытки.');

export const comparisonResponseSchema = z.strictObject({
  protocolVersion: z.literal(1),
  conversationId: z.uuid(),
  runId: z.uuid(),
  turnId: z.uuid(),
  results: z.array(attemptResultSchema).min(1).max(4),
});

export type ComparisonTarget = z.infer<typeof comparisonTargetSchema>;
export type ComparisonRequest = z.infer<typeof comparisonRequestSchema>;
export type RetryRequest = z.infer<typeof retryRequestSchema>;
export type AttemptResult = z.infer<typeof attemptResultSchema>;
export type ComparisonResponse = z.infer<typeof comparisonResponseSchema>;
export type PublicError = z.infer<typeof publicErrorSchema>;

const eventFields = { v: z.literal(1), runId: z.uuid(), turnId: z.uuid(), seq: z.number().int().positive() };
const eventTarget = { columnId: z.uuid(), attemptId: z.uuid(), modelId: z.string() };
export const streamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventFields, type: z.literal('run_started') }),
  z.strictObject({ ...eventFields, type: z.literal('run_completed') }),
  z.strictObject({ ...eventFields, ...eventTarget, type: z.literal('model_started') }),
  z.strictObject({ ...eventFields, ...eventTarget, type: z.literal('answer_delta'), text: z.string() }),
  z.strictObject({ ...eventFields, ...eventTarget, type: z.literal('reasoning_started') }),
  z.strictObject({ ...eventFields, ...eventTarget, type: z.literal('reasoning_delta'), text: z.string() }),
  z.strictObject({ ...eventFields, ...eventTarget, type: z.literal('reasoning_ended') }),
  z.strictObject({ ...eventFields, type: z.literal('model_result'), result: attemptResultSchema }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;

// Shared bounded UTF-8 line decoder. A complete final JSON line without LF is accepted.
export async function* decodeNdjson(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  let complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32 * 1024 * 1024) throw new Error('Поток превышает допустимый размер.');
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (utf8Bytes(line) > 4 * 1024 * 1024) throw new Error('Строка потока слишком велика.');
        if (line.trim()) yield JSON.parse(line) as unknown;
      }
      if (utf8Bytes(buffer) > 4 * 1024 * 1024) throw new Error('Строка потока слишком велика.');
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer) as unknown;
    complete = true;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
