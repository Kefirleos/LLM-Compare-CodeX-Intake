import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { attemptResultSchema, comparisonResponseSchema, modelCatalogSchema, streamEventSchema } from '@llm-compare/contracts';
import type { ComparisonRequest, ModelPricing } from '@llm-compare/contracts';
import { CodexProxyAdapter } from '../apps/server/src/adapters/codex-proxy';
import { buildApp } from '../apps/server/src/app';
import { usageMetrics } from '../apps/server/src/generation/metrics';
import { comparisonLeaders, formatEstimatedCost } from '../apps/web/src/features/comparison/metrics';
import { conversationDataSchema } from '../apps/web/src/features/storage/schema';

const pricing: ModelPricing = { inputPerMillion: 0.1, outputPerMillion: 0.2, currency: 'USD' };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture(usage: unknown, options: { rate?: unknown; missingFinish?: boolean; error?: boolean } = {}) {
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === '/models') return Response.json({ models: ['a', 'b'].map((id) => ({
      id, name: id, pricing: options.rate ?? { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.15 },
    })) });
    if (path === '/generate') return Response.json({ text: 'Answer', usage });
    expect(path).toBe('/stream');
    expect(init?.method).toBe('POST');
    const events: unknown[] = [{ type: 'text-delta', delta: 'Answer' }];
    if (options.error) events.push({ type: 'error' });
    else if (!options.missingFinish) events.push({ type: 'finish', usage });
    return new Response(events.map((event) => JSON.stringify(event)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } });
  };
  const app = buildApp(new CodexProxyAdapter('local-test-fixture', transport));
  apps.push(app);
  const request: ComparisonRequest = {
    protocolVersion: 1, conversationId: randomUUID(), runId: randomUUID(), turnId: randomUUID(), prompt: 'Question',
    targets: ['a', 'b'].map((modelId) => ({ modelId, columnId: randomUUID(), attemptId: randomUUID(), history: [] })),
  };
  return { app, request, calls };
}

it.each(['json', 'stream'] as const)('carries reported counts and server catalog pricing to %s results', async (mode) => {
  const { app, request, calls } = fixture({ inputTokens: 100, outputTokens: 20, reasoningTokens: 10, cachedInputTokens: 50 });
  const catalog = modelCatalogSchema.parse((await app.inject('/api/models')).json());
  expect(catalog.models[0]?.pricing).toEqual({ ...pricing, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.15 });
  const response = await app.inject({
    method: 'POST', url: '/api/comparisons', payload: request,
    ...(mode === 'stream' ? { headers: { accept: 'application/x-ndjson' } } : {}),
  });
  expect(response.statusCode).toBe(200);
  const events = mode === 'stream' ? response.body.trim().split('\n').map((line) => streamEventSchema.parse(JSON.parse(line))) : [];
  const results = mode === 'stream' ? events.flatMap((event) => event.type === 'model_result' ? [event.result] : [])
    : comparisonResponseSchema.parse(response.json()).results;
  expect(results).toHaveLength(2);
  for (const result of results) expect(result.metrics).toMatchObject({
    inputTokens: 100, outputTokens: 20, cost: 0.000014,
    costBasis: { source: 'catalog', method: 'standard_input_output', pricing: catalog.models[0]!.pricing },
  });
  if (mode === 'stream') {
    expect(events.at(-1)?.type).toBe('run_completed');
    expect(events.filter((event) => event.type === 'reasoning_started')).toHaveLength(0);
  } else expect(results[0]?.metrics?.firstAnswerMs).toBeNull();
  expect(calls.filter((path) => path === '/models')).toHaveLength(1);
});

it.each([
  [undefined, null, null],
  [{}, null, null],
  [null, null, null],
  [{ inputTokens: 0 }, 0, null],
  [{ inputTokens: -1, outputTokens: 2 }, null, 2],
  [{ inputTokens: 0.5, outputTokens: '2' }, null, null],
  [{ inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 }, null, 0],
] as const)('preserves missing or invalid usage as unknown for %j', async (usage, inputTokens, outputTokens) => {
  const { app, request } = fixture(usage);
  const response = await app.inject({ method: 'POST', url: '/api/comparisons', payload: request });
  const results = comparisonResponseSchema.parse(response.json()).results;
  expect(results[0]).toMatchObject({ status: 'succeeded', metrics: { inputTokens, outputTokens, cost: null } });
  expect(results[0]?.metrics?.costBasis).toBeUndefined();
});

it.each([{ input: -1, output: 2 }, { input: '1', output: 2 }, {}])('keeps valid usage when pricing is unusable: %j', async (rate) => {
  const { app, request } = fixture({ inputTokens: 20, outputTokens: 5 }, { rate });
  const response = await app.inject({ method: 'POST', url: '/api/comparisons', payload: request });
  expect(comparisonResponseSchema.parse(response.json()).results[0]?.metrics).toMatchObject({ inputTokens: 20, outputTokens: 5, cost: null });
});

it.each([{ missingFinish: true }, { error: true }])('never assigns a cost or usage to a failed stream: %j', async (options) => {
  const { app, request } = fixture({ inputTokens: 20, outputTokens: 5 }, options);
  const response = await app.inject({ method: 'POST', url: '/api/comparisons', payload: request, headers: { accept: 'application/x-ndjson' } });
  const events = response.body.trim().split('\n').map((line) => streamEventSchema.parse(JSON.parse(line)));
  for (const event of events) if (event.type === 'model_result') expect(event.result).toMatchObject({
    status: 'failed', text: 'Answer', metrics: { inputTokens: null, outputTokens: null, cost: null },
  });
});

it('adds decimal amounts exactly and distinguishes free usage, unknown counts and tiny estimates', () => {
  expect(usageMetrics({ inputTokens: 1, outputTokens: 1 }, pricing).cost).toBe(0.0000003);
  expect(usageMetrics({ inputTokens: 0, outputTokens: 0 }, pricing).cost).toBe(0);
  expect(usageMetrics({ inputTokens: 1, outputTokens: 1 }, { ...pricing, inputPerMillion: 0, outputPerMillion: 0 }).cost).toBe(0);
  expect(usageMetrics({ inputTokens: 1, outputTokens: null }, pricing).cost).toBeNull();
  expect(usageMetrics({ inputTokens: 1, outputTokens: 1 })).toMatchObject({ cost: null });
  expect(formatEstimatedCost(0.0000003)).not.toBe(formatEstimatedCost(0));
  expect(usageMetrics({ inputTokens: 1, outputTokens: 0 }, { ...pricing, inputPerMillion: 1e-9 }).cost).toBe(1e-15);
});

it('uses refreshed server pricing for a retry while preserving the first attempt estimate', async () => {
  const options = { rate: { input: 0.1, output: 0.2 } };
  const { app, request } = fixture({ inputTokens: 100, outputTokens: 20 }, options);
  const first = comparisonResponseSchema.parse((await app.inject({ method: 'POST', url: '/api/comparisons', payload: request })).json());
  options.rate = { input: 1, output: 2 };
  await app.inject('/api/models?refresh=1');
  const target = { ...request.targets[0]!, attemptId: randomUUID() };
  const repeated = await app.inject({ method: 'POST', url: '/api/retries', payload: {
    protocolVersion: 1, conversationId: request.conversationId, runId: randomUUID(), turnId: request.turnId,
    prompt: request.prompt, target,
  } });
  expect(comparisonResponseSchema.parse(repeated.json()).results[0]?.metrics).toMatchObject({
    cost: 0.00014, costBasis: { pricing: { inputPerMillion: 1, outputPerMillion: 2 } },
  });
  expect(first.results[0]?.metrics).toMatchObject({
    cost: 0.000014, costBasis: { pricing: { inputPerMillion: 0.1, outputPerMillion: 0.2 } },
  });
});

it('ranks only settled successful estimates, including zero, using values before display rounding', () => {
  const result = (cost: number) => attemptResultSchema.parse({
    columnId: randomUUID(), attemptId: randomUUID(), modelId: 'a', totalMs: 10, status: 'succeeded', text: 'ok', error: null,
    metrics: { firstEventMs: null, firstAnswerMs: null, ...usageMetrics({ inputTokens: 1, outputTokens: 1 }, { ...pricing, inputPerMillion: cost * 500000, outputPerMillion: cost * 500000 }) },
  });
  const a = result(0), b = result(0.000001);
  expect([...comparisonLeaders({ a, b }, true).cost]).toEqual(['a']);
  expect(comparisonLeaders({ a, b }, false).cost.size).toBe(0);
  expect(comparisonLeaders({ a, b: { ...b, status: 'failed', error: { code: 'GENERATION_FAILED', message: 'error', retryable: true } } }, true).cost.size).toBe(0);
  const c = result(0.1234401), d = result(0.1234402);
  expect(formatEstimatedCost(c.metrics!.cost!)).toBe(formatEstimatedCost(d.metrics!.cost!));
  expect([...comparisonLeaders({ c, d }, true).cost]).toEqual(['c']);
});

it('restores old null metrics and new estimates with their original tariff snapshot', () => {
  const columns = ['a', 'b'].map((id) => ({ columnId: randomUUID(), model: {
    id, displayName: id, provider: 'Test', capabilities: { streaming: 'unknown', reasoning: 'unknown' }, pricing: null, metadataSource: 'upstream',
  } }));
  const targets = columns.map((column) => ({ modelId: column.model.id, columnId: column.columnId, attemptId: randomUUID(), history: [] }));
  const results = Object.fromEntries(targets.map((target, index) => [target.columnId, {
    columnId: target.columnId, attemptId: target.attemptId, modelId: target.modelId,
    status: 'succeeded', text: 'ok', totalMs: 10, error: null,
    metrics: { firstEventMs: null, firstAnswerMs: null, ...usageMetrics(index ? { inputTokens: 1, outputTokens: 1 } : undefined, pricing) },
  }]));
  const data = { conversationId: randomUUID(), mode: 'live', columns, activeColumn: '', draft: '', turns: [{
    turnId: randomUUID(), prompt: 'Q', targets, results, serializerVersion: 1, attempts: {},
  }] };
  expect(conversationDataSchema.parse(JSON.parse(JSON.stringify(data)))).toEqual(data);
});
