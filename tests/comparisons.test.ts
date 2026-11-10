import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { comparisonResponseSchema } from '@llm-compare/contracts';
import type { ComparisonRequest } from '@llm-compare/contracts';
import { buildApp } from '../apps/server/src/app.js';
import { FakeAdapter } from '../apps/server/src/adapters/fake.js';
import type { LlmAdapter } from '../apps/server/src/adapters/types.js';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});
function createApp(adapter: LlmAdapter = new FakeAdapter(), timeoutMs = 1000) {
  const app = buildApp(adapter, { attemptTimeoutMs: timeoutMs });
  apps.push(app);
  return app;
}
function input(ids = ['mock-clear', 'mock-detailed']): ComparisonRequest {
  return {
    protocolVersion: 1, conversationId: randomUUID(), runId: randomUUID(), turnId: randomUUID(), prompt: '  Привет 👋\n  мир',
    targets: ids.map((modelId) => ({ columnId: randomUUID(), attemptId: randomUUID(), modelId, history: [] })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('comparison validation before fan-out', () => {
  it.each([
    ['one model', (body: ComparisonRequest) => { body.targets.pop(); }],
    ['five models', (body: ComparisonRequest) => { body.targets = input(['a', 'b', 'c', 'd', 'e']).targets; }],
    ['duplicate model', (body: ComparisonRequest) => { body.targets[1]!.modelId = body.targets[0]!.modelId; }],
    ['duplicate column', (body: ComparisonRequest) => { body.targets[1]!.columnId = body.targets[0]!.columnId; }],
    ['duplicate attempt', (body: ComparisonRequest) => { body.targets[1]!.attemptId = body.targets[0]!.attemptId; }],
    ['blank prompt', (body: ComparisonRequest) => { body.prompt = ' \n\t'; }],
    ['UTF-8 byte limit', (body: ComparisonRequest) => { body.prompt = 'я'.repeat(8193); }],
    ['extra field', (body: ComparisonRequest) => { Object.assign(body, { baseURL: 'https://untrusted.invalid' }); }],
    ['unsupported history', (body: ComparisonRequest) => { Object.assign(body.targets[0]!, { history: [{ user: 'q', assistant: 'a' }] }); }],
  ])('rejects %s without starting generation', async (_name, mutate) => {
    const adapter = new FakeAdapter();
    const generate = vi.spyOn(adapter, 'generate');
    const body = input();
    mutate(body);
    const response = await createApp(adapter).inject({ method: 'POST', url: '/api/comparisons', payload: body });
    expect(response.statusCode).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects an unavailable model before generating any answer', async () => {
    const adapter = new FakeAdapter();
    const generate = vi.spyOn(adapter, 'generate');
    const response = await createApp(adapter).inject({ method: 'POST', url: '/api/comparisons', payload: input(['mock-clear', 'missing']) });
    expect(response.statusCode).toBe(422);
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns safe 400, 413 and 415 responses', async () => {
    const app = createApp();
    for (const [payload, contentType, status] of [
      ['{private-value', 'application/json', 400],
      ['x'.repeat(256 * 1024 + 1), 'application/json', 413],
      ['private-value', 'application/xml', 415],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/comparisons', headers: { 'content-type': contentType }, payload });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain('private-value');
    }
  });
});

describe('parallel executor and isolated results', () => {
  it('starts all four models before any is allowed to finish, preserving prompt and IDs', async () => {
    const adapter = new FakeAdapter();
    const gates = Array.from({ length: 4 }, () => deferred<{ text: string }>());
    const started = deferred<void>();
    const generate = vi.spyOn(adapter, 'generate').mockImplementation(() => {
      const gate = gates[generate.mock.calls.length - 1]!;
      if (generate.mock.calls.length === 4) started.resolve();
      return gate.promise;
    });
    const body = input(['mock-clear', 'mock-detailed', 'mock-slow', 'mock-error']);
    const responsePromise = createApp(adapter).inject({ method: 'POST', url: '/api/comparisons', payload: body });
    await started.promise;
    expect(generate).toHaveBeenCalledTimes(4);
    expect(generate.mock.calls.every(([request]) => request.prompt === body.prompt)).toBe(true);
    gates.forEach((gate, index) => gate.resolve({ text: `answer ${index}` }));
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    const result = comparisonResponseSchema.parse(response.json());
    expect(result.runId).toBe(body.runId);
    result.results.forEach((attempt, index) => {
      expect(attempt.status).toBe('succeeded');
      expect(attempt.columnId).toBe(body.targets[index]!.columnId);
      expect(attempt.text).toBe(`answer ${index}`);
      expect(attempt.totalMs).toBeGreaterThanOrEqual(0);
    });
  });

  it('returns success, safe failure and timeout together, even if one adapter ignores abort', async () => {
    const adapter = new FakeAdapter();
    vi.spyOn(adapter, 'generate').mockImplementation(async ({ modelId }) => {
      if (modelId === 'mock-clear') return { text: 'успех' };
      if (modelId === 'mock-error') throw new Error('private-provider-error');
      return new Promise(() => {});
    });
    const response = await createApp(adapter, 20).inject({ method: 'POST', url: '/api/comparisons', payload: input(['mock-clear', 'mock-error', 'mock-slow']) });
    expect(response.statusCode).toBe(200);
    const results = comparisonResponseSchema.parse(response.json()).results;
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'failed', 'timed_out']);
    expect(response.body).not.toContain('private-provider-error');
  });

  it('rejects oversized answers without losing another result', async () => {
    const adapter = new FakeAdapter();
    vi.spyOn(adapter, 'generate').mockImplementation(async ({ modelId }) => ({ text: modelId === 'mock-clear' ? 'x'.repeat(512 * 1024 + 1) : 'ok' }));
    const response = await createApp(adapter).inject({ method: 'POST', url: '/api/comparisons', payload: input() });
    const results = comparisonResponseSchema.parse(response.json()).results;
    expect(results[0]!.error?.code).toBe('OUTPUT_LIMIT');
    expect(results[1]!.text).toBe('ok');
  });

  it('retries only the requested target using the original prompt', async () => {
    const adapter = new FakeAdapter();
    const generate = vi.spyOn(adapter, 'generate').mockResolvedValue({ text: 'Повторный ответ' });
    const body = input();
    const { targets, ...fields } = body;
    const response = await createApp(adapter).inject({ method: 'POST', url: '/api/retries', payload: { ...fields, target: targets[1] } });
    expect(response.statusCode).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toEqual({ modelId: 'mock-detailed', prompt: body.prompt });
    expect(comparisonResponseSchema.parse(response.json()).results).toHaveLength(1);
  });

  it('blocks duplicate run IDs without repeating generation', async () => {
    const adapter = new FakeAdapter();
    const generate = vi.spyOn(adapter, 'generate').mockResolvedValue({ text: 'ok' });
    const app = createApp(adapter);
    const body = input();
    expect((await app.inject({ method: 'POST', url: '/api/comparisons', payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/comparisons', payload: body })).statusCode).toBe(409);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('reserves all slots and releases capacity after completion', async () => {
    const adapter = new FakeAdapter();
    const gate = deferred<{ text: string }>();
    const started = deferred<void>();
    const generate = vi.spyOn(adapter, 'generate').mockImplementation(() => {
      if (generate.mock.calls.length === 8) started.resolve();
      return gate.promise;
    });
    const app = createApp(adapter);
    const ids = ['mock-clear', 'mock-detailed', 'mock-slow', 'mock-error'];
    const first = app.inject({ method: 'POST', url: '/api/comparisons', payload: input(ids) });
    const second = app.inject({ method: 'POST', url: '/api/comparisons', payload: input(ids) });
    await started.promise;
    const busy = await app.inject({ method: 'POST', url: '/api/comparisons', payload: input() });
    expect(busy.statusCode).toBe(429);
    expect(generate).toHaveBeenCalledTimes(8);
    gate.resolve({ text: 'ok' });
    await Promise.all([first, second]);
    expect((await app.inject({ method: 'POST', url: '/api/comparisons', payload: input() })).statusCode).toBe(200);
  });
});
