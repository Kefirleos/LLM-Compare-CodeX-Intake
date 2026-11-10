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

const promptSchema = z.string().max(MAX_PROMPT_BYTES)
  .refine((value) => value.trim().length > 0, 'Введите вопрос.')
  .refine((value) => utf8Bytes(value) <= MAX_PROMPT_BYTES, 'Вопрос превышает 16 КиБ.');

export const comparisonTargetSchema = z.strictObject({
  columnId: z.uuid(),
  modelId: z.string().min(1).max(256),
  attemptId: z.uuid(),
  // This version accepts standalone questions only.
  history: z.array(z.never()).max(0),
});

const requestFields = {
  protocolVersion: z.literal(1),
  conversationId: z.uuid(),
  runId: z.uuid(),
  turnId: z.uuid(),
  prompt: promptSchema,
};

export const comparisonRequestSchema = z.strictObject({
  ...requestFields,
  targets: z.array(comparisonTargetSchema).min(2).max(4),
}).superRefine(({ targets }, context) => {
  for (const field of ['columnId', 'modelId', 'attemptId'] as const) {
    if (new Set(targets.map((target) => target[field])).size !== targets.length) {
      context.addIssue({ code: 'custom', path: ['targets'], message: `Duplicate ${field}` });
    }
  }
});

export const retryRequestSchema = z.strictObject({
  ...requestFields,
  target: comparisonTargetSchema,
});

const resultFields = {
  columnId: z.uuid(),
  attemptId: z.uuid(),
  modelId: z.string(),
  totalMs: z.number().nonnegative(),
};

export const attemptResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...resultFields, status: z.literal('succeeded'), text: z.string(), error: z.null() }),
  z.strictObject({
    ...resultFields,
    status: z.enum(['failed', 'timed_out', 'cancelled']),
    text: z.literal(''),
    error: publicErrorSchema,
  }),
]);

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
