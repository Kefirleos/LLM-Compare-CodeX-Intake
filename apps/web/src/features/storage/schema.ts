import { z } from 'zod';
import { attemptResultSchema, comparisonTargetSchema, modelDescriptorSchema, MAX_PROMPT_BYTES, utf8Bytes } from '@llm-compare/contracts';

export const MAX_CONVERSATION_BYTES = 2 * 1024 * 1024;
export const MAX_SAVED_CONVERSATIONS = 50;
const partial = { attemptId: z.uuid().optional(), text: z.string().optional(), reasoning: z.string().optional() };
export const displayResultSchema = z.union([
  attemptResultSchema,
  z.strictObject({ ...partial, status: z.literal('pending'), reasoningActive: z.boolean().optional() }),
  z.strictObject({ ...partial, status: z.enum(['network_error', 'stopped', 'interrupted']), message: z.string(), code: z.literal('NETWORK_INTERRUPTED').optional() }),
]);
export type StoredDisplayResult = z.infer<typeof displayResultSchema>;
const turnSchema = z.strictObject({
  turnId: z.uuid(), prompt: z.string().max(MAX_PROMPT_BYTES).refine((text) => utf8Bytes(text) <= MAX_PROMPT_BYTES), serializerVersion: z.literal(1),
  targets: z.array(comparisonTargetSchema).min(1).max(4),
  results: z.record(z.uuid(), displayResultSchema), attempts: z.record(z.uuid(), z.array(displayResultSchema).max(50)),
});
export const conversationDataSchema = z.strictObject({
  conversationId: z.uuid(), mode: z.enum(['mock', 'live']),
  columns: z.array(z.strictObject({ columnId: z.uuid(), model: modelDescriptorSchema })).min(2).max(4),
  activeColumn: z.union([z.uuid(), z.literal('')]), draft: z.string().max(256 * 1024), turns: z.array(turnSchema).max(100),
}).superRefine((data, ctx) => {
  if (new Set(data.columns.map((column) => column.columnId)).size !== data.columns.length
    || new Set(data.columns.map((column) => column.model.id)).size !== data.columns.length
    || new Set(data.turns.map((turn) => turn.turnId)).size !== data.turns.length) ctx.addIssue({ code: 'custom', message: 'Duplicate identifiers' });
  for (const turn of data.turns) {
    const targets = new Map(turn.targets.map((target) => [target.columnId, target]));
    if (targets.size !== turn.targets.length) ctx.addIssue({ code: 'custom', message: 'Duplicate targets' });
    for (const [id, result] of Object.entries(turn.results)) {
      const target = targets.get(id);
      if (!target || ('columnId' in result && (result.columnId !== id || result.modelId !== target.modelId))) ctx.addIssue({ code: 'custom', message: 'Result identity mismatch' });
    }
  }
});
export type ConversationData = z.infer<typeof conversationDataSchema>;
export const savedConversationSchema = z.strictObject({
  schemaVersion: z.literal(1), status: z.literal('saved'), conversationId: z.uuid(), revision: z.number().int().positive(),
  generation: z.number().int().nonnegative(), updatedAt: z.number().nonnegative(), data: conversationDataSchema,
}).refine((record) => record.conversationId === record.data.conversationId, 'Conversation identity mismatch');
export type SavedConversation = z.infer<typeof savedConversationSchema>;

export function validateData(input: unknown): ConversationData {
  const data = conversationDataSchema.parse(input);
  if (utf8Bytes(JSON.stringify(data)) > MAX_CONVERSATION_BYTES) throw new Error('CONVERSATION_TOO_LARGE');
  return data;
}
export function recoverConversation(data: ConversationData): ConversationData {
  if (!data.turns.some((turn) => Object.values(turn.results).some((result) => result.status === 'pending')
    || Object.values(turn.attempts).some((attempts) => attempts.some((result) => result.status === 'pending')))) return data;
  const recover = (result: z.infer<typeof displayResultSchema>): z.infer<typeof displayResultSchema> => result.status !== 'pending' ? result : {
    status: 'interrupted', code: 'NETWORK_INTERRUPTED', message: 'Страница была закрыта до завершения ответа. Полученный текст сохранён; запрос автоматически не повторяется.',
    ...(result.attemptId ? { attemptId: result.attemptId } : {}), text: result.text ?? '', reasoning: result.reasoning ?? '',
  };
  return { ...data, turns: data.turns.map((turn) => ({ ...turn,
    results: Object.fromEntries(Object.entries(turn.results).map(([id, result]) => [id, recover(result)])),
    attempts: Object.fromEntries(Object.entries(turn.attempts).map(([id, attempts]) => [id, attempts.map(recover)])),
  })) };
}
