import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { comparisonResponseSchema, modelCatalogSchema } from '@llm-compare/contracts';
import { CodexProxyAdapter } from '../apps/server/src/adapters/codex-proxy.js';
import { createAdapter } from '../apps/server/src/adapters/index.js';
import { loadConfig } from '../apps/server/src/config/index.js';
import { buildApp } from '../apps/server/src/app.js';

const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });
const fixtureKey = 'test-fixture-key-not-a-real-credential';
const modelPayload = { models: [
  { id: 'openai/test-a', name: 'Model A' },
  { id: 'anthropic/test-b', name: 'Model B' },
  { id: 'unknown/test-c', name: 'Model C' },
] };

function fixture() {
  const upstream = Fastify();
  servers.push(upstream);
  const list = vi.fn<(request: FastifyRequest, reply: FastifyReply) => unknown>(() => modelPayload);
  const generate = vi.fn<(request: FastifyRequest, reply: FastifyReply) => unknown>(() => ({ text: '# Ответ\n\n  Привет 👋\n' }));
  upstream.get('/models', async (request, reply) => list(request, reply));
  upstream.post('/generate', async (request, reply) => generate(request, reply));
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://llm.codex.so') throw new Error('Unexpected destination');
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await upstream.inject({
      method: init?.method === 'POST' ? 'POST' : 'GET', url: url.pathname, headers,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': String(response.headers['content-type']) } });
  });
  const adapter = new CodexProxyAdapter(fixtureKey, transport);
  return { upstream, list, generate, transport, adapter };
}

describe('CodeX proxy HTTP contract', () => {
  it('gets real names in upstream order and neutral metadata, with server-only auth', async () => {
    const { adapter, list, transport } = fixture();
    const models = await adapter.listModels(new AbortController().signal);
    expect(models.map((model) => model.displayName)).toEqual(['Model A', 'Model B', 'Model C']);
    expect(models.map((model) => model.provider)).toEqual(['OpenAI', 'Anthropic', 'Провайдер не указан']);
    expect(models.every((model) => model.pricing === null && model.capabilities.reasoning === 'unknown')).toBe(true);
    expect(list.mock.calls[0]![0].headers['x-api-key']).toBe(fixtureKey);
    expect(transport.mock.calls[0]![1]?.redirect).toBe('error');
    expect(JSON.stringify(adapter)).not.toContain(fixtureKey);
    expect(JSON.stringify(models)).not.toContain(fixtureKey);
  });

  it('sends exactly prompt and model and preserves returned whitespace and Unicode', async () => {
    const { adapter, generate } = fixture();
    const signal = new AbortController().signal;
    const prompt = '  Вопрос 👋\n\n  с отступами';
    const answer = await adapter.generate({ prompt, modelId: 'openai/test-a' }, signal);
    expect(generate.mock.calls[0]![0].body).toEqual({ prompt, model: 'openai/test-a' });
    expect(generate.mock.calls[0]![0].headers['x-api-key']).toBe(fixtureKey);
    expect(answer.text).toBe('# Ответ\n\n  Привет 👋\n');
  });

  it('integrates with public catalog and comparison routes without leaking fixture credentials', async () => {
    const { adapter, generate } = fixture();
    const app = buildApp(adapter);
    servers.push(app);
    const catalog = await app.inject('/api/models');
    expect(modelCatalogSchema.parse(catalog.json()).mode).toBe('live');
    const response = await app.inject({ method: 'POST', url: '/api/comparisons', payload: {
      protocolVersion: 1, conversationId: randomUUID(), runId: randomUUID(), turnId: randomUUID(), prompt: 'Вопрос',
      targets: ['openai/test-a', 'anthropic/test-b'].map((modelId) => ({ columnId: randomUUID(), attemptId: randomUUID(), modelId, history: [] })),
    } });
    expect(response.statusCode).toBe(200);
    expect(comparisonResponseSchema.parse(response.json()).results.every((result) => result.status === 'succeeded')).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(catalog.body + response.body).not.toContain(fixtureKey);
  });

  it.each([
    [401, 'UPSTREAM_AUTH', false], [403, 'UPSTREAM_AUTH', false],
    [429, 'UPSTREAM_RATE_LIMIT', true], [500, 'UPSTREAM_UNAVAILABLE', true],
    [400, 'UPSTREAM_PROTOCOL', true],
  ] as const)('normalizes HTTP %s without forwarding upstream data or retrying automatically', async (status, code, retryable) => {
    const { adapter, generate, transport } = fixture();
    generate.mockImplementation((_request, reply) => reply.code(status).send({ error: `private-error-${fixtureKey}` }));
    try {
      await adapter.generate({ modelId: 'openai/test-a', prompt: 'x' }, new AbortController().signal);
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toMatchObject({ publicError: { code, retryable } });
      expect(String(error)).not.toContain(fixtureKey);
      expect(JSON.stringify(error)).not.toContain('private-error');
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { models: [{ id: 'duplicate', name: 'A' }, { id: 'duplicate', name: 'B' }] },
    { models: [{ id: 'empty-name', name: '' }] },
    { models: [{ id: 'missing-name' }] },
    { models: 'invalid' },
  ])('rejects an invalid catalog', async (payload) => {
    const { adapter, list } = fixture();
    list.mockReturnValue(payload);
    await expect(adapter.listModels(new AbortController().signal)).rejects.toMatchObject({ publicError: { code: 'UPSTREAM_PROTOCOL' } });
  });

  it('rejects non-JSON and malformed JSON success bodies', async () => {
    const { adapter, generate } = fixture();
    for (const [type, body] of [['text/html', '<html>private-error</html>'], ['application/json', '{bad json']] as const) {
      generate.mockImplementation((_request, reply) => reply.type(type).send(body));
      await expect(adapter.generate({ modelId: 'openai/test-a', prompt: 'x' }, new AbortController().signal)).rejects.toMatchObject({ publicError: { code: 'UPSTREAM_PROTOCOL' } });
    }
  });

  it('requires a string answer and enforces the output byte limit', async () => {
    const { adapter, generate } = fixture();
    generate.mockReturnValue({ text: null });
    await expect(adapter.generate({ modelId: 'openai/test-a', prompt: 'x' }, new AbortController().signal)).rejects.toMatchObject({ publicError: { code: 'UPSTREAM_PROTOCOL' } });
    generate.mockReturnValue({ text: 'я'.repeat(256 * 1024 + 1) });
    await expect(adapter.generate({ modelId: 'openai/test-a', prompt: 'x' }, new AbortController().signal)).rejects.toMatchObject({ publicError: { code: 'OUTPUT_LIMIT' } });
  });

  it('cancels oversized wire data while reading instead of buffering it all', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel,
    });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/json' } }));
    const adapter = new CodexProxyAdapter(fixtureKey, transport);
    await expect(adapter.generate({ modelId: 'x', prompt: 'x' }, new AbortController().signal)).rejects.toMatchObject({ publicError: { code: 'UPSTREAM_PROTOCOL' } });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves cancellation and normalizes transport errors without exposing their messages', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error(`private-transport-${fixtureKey}`));
    const adapter = new CodexProxyAdapter(fixtureKey, transport);
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.listModels(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
    await expect(adapter.listModels(new AbortController().signal)).rejects.toMatchObject({ publicError: { code: 'UPSTREAM_UNAVAILABLE' } });
  });

  it('selects mock by default and never silently substitutes it for live', () => {
    expect(createAdapter(loadConfig({})).mode).toBe('mock');
    expect(createAdapter(loadConfig({ LLM_MODE: 'live', LLM_API_KEY: fixtureKey })).mode).toBe('live');
  });
});
