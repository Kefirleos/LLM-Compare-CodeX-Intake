import { afterEach, describe, expect, it, vi } from 'vitest';
import { healthSchema, modelCatalogSchema, publicErrorSchema } from '@llm-compare/contracts';
import { buildApp } from '../apps/server/src/app.js';
import { FakeAdapter } from '../apps/server/src/adapters/fake.js';
import { loadConfig } from '../apps/server/src/config/index.js';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createApp(adapter = new FakeAdapter()) {
  const app = buildApp(adapter);
  apps.push(app);
  return app;
}

describe('API contracts', () => {
  it('checks health without contacting the adapter', async () => {
    const adapter = new FakeAdapter();
    const list = vi.spyOn(adapter, 'listModels');
    const generate = vi.spyOn(adapter, 'generate');
    const response = await createApp(adapter).inject('/api/health');
    expect(response.statusCode).toBe(200);
    expect(healthSchema.parse(response.json())).toEqual({ status: 'ok' });
    expect(list).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns a validated mock catalog without generating answers', async () => {
    const adapter = new FakeAdapter();
    const generate = vi.spyOn(adapter, 'generate');
    const response = await createApp(adapter).inject('/api/models');
    expect(response.statusCode).toBe(200);
    const catalog = modelCatalogSchema.parse(response.json());
    expect(catalog.mode).toBe('mock');
    expect(catalog.models).toHaveLength(4);
    expect(new Set(catalog.models.map((model) => model.id)).size).toBe(4);
    expect(catalog.models.every((model) => model.pricing === null && model.metadataSource === 'mock')).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });

  it('hides adapter errors from the public response', async () => {
    const adapter = new FakeAdapter();
    vi.spyOn(adapter, 'listModels').mockRejectedValue(new Error('private-upstream-credential'));
    const response = await createApp(adapter).inject('/api/models');
    expect(response.statusCode).toBe(503);
    expect(publicErrorSchema.parse(response.json()).code).toBe('CATALOG_UNAVAILABLE');
    expect(response.body).not.toContain('private-upstream-credential');
    expect(response.body).not.toContain('stack');
  });

  it('returns a safe error for unknown routes', async () => {
    const response = await createApp().inject('/missing?token=private-value');
    expect(response.statusCode).toBe(404);
    expect(publicErrorSchema.parse(response.json()).code).toBe('NOT_FOUND');
    expect(response.body).not.toContain('private-value');
  });
});

describe('server configuration', () => {
  it('starts in mock mode with no key', () => {
    expect(loadConfig({})).toEqual({ host: '127.0.0.1', port: 3001, mode: 'mock' });
  });

  it('rejects live mode rather than silently substituting mock data', () => {
    expect(() => loadConfig({ LLM_MODE: 'live' })).toThrow('LLM_MODE');
  });

  it.each(['0', '65536', 'abc', '3001.5'])('rejects invalid port %s', (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow('PORT');
  });

  it('does not include invalid environment values in errors', () => {
    expect(() => loadConfig({ PORT: 'private-value' })).toThrow('Invalid server configuration: PORT');
  });
});

describe('fake adapter scenarios', () => {
  it('returns prompt text unchanged, including Unicode and line breaks', async () => {
    const adapter = new FakeAdapter({ test: { delayMs: 0, outcome: 'success' } });
    const prompt = 'Привет 👋\n  вторая строка';
    const result = await adapter.generate({ modelId: 'test', prompt }, new AbortController().signal);
    expect(result.text).toContain(prompt);
    expect(result.text).toContain('демонстрационные данные');
  });

  it('can simulate an upstream failure', async () => {
    const adapter = new FakeAdapter({ test: { delayMs: 0, outcome: 'error' } });
    await expect(adapter.generate({ modelId: 'test', prompt: 'x' }, new AbortController().signal)).rejects.toThrow('Simulated provider failure');
  });

  it('rejects unknown models', async () => {
    await expect(new FakeAdapter().generate({ modelId: 'missing', prompt: 'x' }, new AbortController().signal)).rejects.toThrow('Unknown mock model');
  });

  it('cancels a pending response', async () => {
    const adapter = new FakeAdapter({ test: { delayMs: 60_000, outcome: 'success' } });
    const controller = new AbortController();
    const response = adapter.generate({ modelId: 'test', prompt: 'x' }, controller.signal);
    controller.abort();
    await expect(response).rejects.toMatchObject({ name: 'AbortError' });
  });
});
