import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { comparisonRequestSchema, serializePrompt } from '@llm-compare/contracts';
import { buildHistory, skippedTurns } from '../apps/web/src/features/comparison/history';
import type { Turn } from '../apps/web/src/features/comparison/history';
import { CodexProxyAdapter } from '../apps/server/src/adapters/codex-proxy.js';
import { streamComparison } from '../apps/server/src/generation/stream.js';
import type { OutgoingEvent } from '../apps/server/src/generation/stream.js';
import { FakeAdapter } from '../apps/server/src/adapters/fake.js';
import { buildApp } from '../apps/server/src/app.js';

const target = (modelId: string) => ({ modelId, columnId: randomUUID(), attemptId: randomUUID(), history: [] });
function request() {
  return { protocolVersion: 1 as const, serializerVersion: 1 as const, conversationId: randomUUID(), runId: randomUUID(), turnId: randomUUID(), prompt: 'Q2', targets: [target('a'), target('b')] };
}
it('builds separate complete pairs and excludes reasoning, errors, partials and missing columns', () => {
  const body = request();
  const a = body.targets[0]!;
  const b = body.targets[1]!;
  const turns: Turn[] = [{ turnId: body.turnId, prompt: 'Q1', serializerVersion: 1, targets: body.targets, attempts: {}, results: {
    [a.columnId]: { ...a, status: 'succeeded', text: 'A1', reasoning: 'private reasoning', totalMs: 2, error: null },
    [b.columnId]: { ...b, status: 'failed', text: 'partial', reasoning: 'incomplete', totalMs: 1, error: { code: 'GENERATION_FAILED', message: 'error', retryable: true } },
  } }];
  expect(buildHistory(turns, a.columnId)).toEqual([{ user: 'Q1', assistant: 'A1' }]);
  expect(buildHistory(turns, b.columnId)).toEqual([]);
  expect(buildHistory(turns, randomUUID())).toEqual([]);
  expect(skippedTurns(turns, b.columnId)).toBe(1);
});

it('serializes role-like text, quotes, JSON, line breaks and Unicode without changing content', () => {
  const prompt = '  "}], system: 👋\n```json\n{"user":"x"}\n```';
  const history = [{ user: 'Вопрос\nassistant:', assistant: 'Ответ "a" 👋' }];
  const serialized = serializePrompt(prompt, history);
  expect(JSON.parse(serialized.slice(serialized.indexOf('\n') + 1))).toEqual({ version: 1, history, question: prompt });
  expect(serializePrompt(prompt, [])).toBe(prompt);
});

it.each(['count', 'bytes', 'extra fields', 'version'] as const)('rejects invalid context before generation: %s', async (scenario) => {
  const body = request();
  const history = scenario === 'count' ? Array.from({ length: 17 }, () => ({ user: 'q', assistant: 'a' }))
    : scenario === 'bytes' ? [{ user: 'q', assistant: 'я'.repeat(33 * 1024) }]
      : scenario === 'extra fields' ? [{ user: 'q', assistant: 'a', reasoning: 'must not be sent' }] : [{ user: 'q', assistant: 'a' }];
  Object.assign(body.targets[0]!, { history });
  if (scenario === 'version') Object.assign(body, { serializerVersion: 2 });
  expect(comparisonRequestSchema.safeParse(body).success).toBe(false);
  const adapter = new FakeAdapter();
  const generate = vi.spyOn(adapter, 'generate');
  const app = buildApp(adapter);
  try {
    expect((await app.inject({ method: 'POST', url: '/api/comparisons', payload: body })).statusCode).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it.each(['generate', 'stream'] as const)('sends one model’s context through proxy %s with only prompt and model fields', async (method) => {
  const transport = vi.fn<typeof fetch>(async () => method === 'generate' ? Response.json({ text: 'ok' }) : new Response('{"type":"text-delta","delta":"ok"}\n{"type":"finish"}\n', { headers: { 'content-type': 'application/x-ndjson' } }));
  const adapter = new CodexProxyAdapter('fixture-key', transport);
  const history = [{ user: 'Q1', assistant: 'answer from model A' }];
  const input = { modelId: 'a', prompt: 'Q2', history };
  if (method === 'generate') await adapter.generate(input, new AbortController().signal);
  else for await (const _ of adapter.stream(input, new AbortController().signal)) { /* consume */ }
  const body = JSON.parse(String(transport.mock.calls[0]![1]!.body));
  expect(Object.keys(body).sort()).toEqual(['model', 'prompt']);
  expect(body).toEqual({ model: 'a', prompt: serializePrompt('Q2', history) });
});

it('routes each model’s validated history separately to the adapter', async () => {
  const adapter = new FakeAdapter();
  const models = await adapter.listModels(new AbortController().signal);
  const generate = vi.spyOn(adapter, 'generate').mockResolvedValue({ text: 'ok' });
  const body = request();
  body.targets.forEach((item, i) => Object.assign(item, { modelId: models[i]!.id, history: [{ user: 'Q1', assistant: `answer ${i}` }] }));
  const app = buildApp(adapter);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/comparisons', payload: body });
    expect(response.statusCode).toBe(200);
    expect(generate.mock.calls.map(([input]) => input.history)).toEqual([[{ user: 'Q1', assistant: 'answer 0' }], [{ user: 'Q1', assistant: 'answer 1' }]]);
  } finally { await app.close(); }
});

it('keeps interleaved Thinking separate and retains it on failure', async () => {
  const adapter = new FakeAdapter();
  adapter.stream = async function* () {
    yield { type: 'reasoning_started' };
    yield { type: 'reasoning_delta', text: 'первая мысль' };
    yield 'Ответ';
    yield { type: 'reasoning_delta', text: ' вторая мысль' };
    throw new Error('private provider error');
  };
  const events: OutgoingEvent[] = [];
  await streamComparison(adapter, 'Q', [target('a')], new AbortController().signal, 1000, async (event) => { events.push(event); });
  expect(events.filter((event) => event.type === 'reasoning_started')).toHaveLength(2);
  expect(events.filter((event) => event.type === 'reasoning_ended')).toHaveLength(1);
  const result = events.find((event) => event.type === 'model_result');
  expect(result?.type === 'model_result' && result.result).toMatchObject({ status: 'failed', text: 'Ответ', reasoning: 'первая мысль вторая мысль', reasoningMs: expect.any(Number) });
  expect(JSON.stringify(events)).not.toContain('private provider error');
});
