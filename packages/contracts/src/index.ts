import { z } from 'zod';

export const capabilitySchema = z.enum(['supported', 'unsupported', 'unknown']);

export const modelPricingSchema = z.strictObject({
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
  cacheReadPerMillion: z.number().nonnegative().optional(),
  cacheWritePerMillion: z.number().nonnegative().optional(),
  currency: z.literal('USD'),
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;

export const modelDescriptorSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.string().min(1),
  capabilities: z.strictObject({
    streaming: capabilitySchema,
    reasoning: capabilitySchema,
  }),
  pricing: modelPricingSchema.nullable(),
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
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cost: z.number().nonnegative().nullable(),
  costBasis: z.strictObject({
    source: z.literal('catalog'),
    method: z.literal('standard_input_output'),
    calculatedAt: z.number().nonnegative(),
    pricing: modelPricingSchema,
  }).optional(),
}).refine(({ firstEventMs, firstAnswerMs }) => firstAnswerMs === null || (firstEventMs !== null && firstEventMs <= firstAnswerMs), 'Первый ответ не может предшествовать первым данным.')
  .refine(({ inputTokens, outputTokens, cost }) => cost === null || (inputTokens !== null && outputTokens !== null), 'Для оценки стоимости нужны оба счётчика токенов.')
  .refine(({ cost, costBasis }) => cost === null ? !costBasis : Boolean(costBasis), 'Оценка стоимости должна содержать источник тарифа.');
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

export const MAX_NDJSON_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_NDJSON_STREAM_BYTES = 32 * 1024 * 1024;

// Shared bounded UTF-8 line decoder. A complete final JSON line without LF is accepted.
export async function* decodeNdjson(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let buffer = new Uint8Array();
  let bufferedLength = 0;
  let firstLine = true;
  let bytes = 0;
  let complete = false;

  const startsWithBom = (data: Uint8Array) => data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  // A geometrically grown buffer copies only fragments of a line, without re-encoding earlier bytes.
  const append = (part: Uint8Array) => {
    const length = bufferedLength + part.length;
    const limitWithBom = MAX_NDJSON_LINE_BYTES + (firstLine ? 3 : 0);
    if (length > limitWithBom) throw new Error('Строка потока слишком велика.');
    if (length > buffer.length) {
      const expanded = new Uint8Array(Math.min(limitWithBom, Math.max(length, buffer.length * 2)));
      expanded.set(buffer.subarray(0, bufferedLength));
      buffer = expanded;
    }
    buffer.set(part, bufferedLength);
    bufferedLength = length;
    if (length > MAX_NDJSON_LINE_BYTES && !startsWithBom(buffer)) throw new Error('Строка потока слишком велика.');
  };
  const parseLine = (line: Uint8Array): unknown => {
    if (firstLine && startsWithBom(line)) line = line.subarray(3);
    firstLine = false;
    if (line.length > MAX_NDJSON_LINE_BYTES) throw new Error('Строка потока слишком велика.');
    const text = decoder.decode(line);
    return text.trim() ? JSON.parse(text) as unknown : undefined;
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) { complete = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_NDJSON_STREAM_BYTES) throw new Error('Поток превышает допустимый размер.');
      const data = chunk.value;
      let start = 0;
      while (start < data.length) {
        signal.throwIfAborted();
        const end = data.indexOf(0x0a, start);
        if (end < 0) { append(data.subarray(start)); break; }
        const part = data.subarray(start, end);
        if (bufferedLength) append(part);
        const value = parseLine(bufferedLength ? buffer.subarray(0, bufferedLength) : part);
        bufferedLength = 0;
        start = end + 1;
        if (value !== undefined) yield value;
      }
    }
    if (bufferedLength) {
      const value = parseLine(buffer.subarray(0, bufferedLength));
      if (value !== undefined) yield value;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    // An underlying stream can keep its cancel promise pending after the reader is closed.
    if (!complete) abort();
    reader.releaseLock();
  }
}
