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
  code: z.enum(['CATALOG_UNAVAILABLE', 'INTERNAL_ERROR', 'NOT_FOUND']),
  message: z.string(),
  retryable: z.boolean(),
});

export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
