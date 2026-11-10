import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogService } from '../apps/server/src/catalog/service.js';
import { FakeAdapter } from '../apps/server/src/adapters/fake.js';

const services: CatalogService[] = [];
afterEach(() => services.splice(0).forEach((service) => service.close()));
function service(adapter: FakeAdapter, now?: () => number) {
  const catalog = new CatalogService(adapter, now);
  services.push(catalog);
  return catalog;
}
const signal = () => new AbortController().signal;

describe('catalog freshness and shared loads', () => {
  it('shares one refresh among concurrent callers and caches it for 60 seconds', async () => {
    const adapter = new FakeAdapter();
    const load = vi.spyOn(adapter, 'listModels');
    const catalog = service(adapter);
    const [first, second] = await Promise.all([catalog.get(signal()), catalog.get(signal())]);
    expect(first).toEqual(second);
    expect(load).toHaveBeenCalledTimes(1);
    await catalog.get(signal());
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not let a caller mutate a cached model or another callers snapshot', async () => {
    const catalog = service(new FakeAdapter());
    const first = await catalog.get(signal());
    first.models[0]!.displayName = 'changed';
    const second = await catalog.get(signal());
    expect(second.models[0]!.displayName).not.toBe('changed');
  });

  it('bypasses a fresh cache on manual refresh and changes the catalog version with its content', async () => {
    const adapter = new FakeAdapter();
    const load = vi.spyOn(adapter, 'listModels');
    const catalog = service(adapter);
    const first = await catalog.get(signal());
    const models = structuredClone(first.models);
    models.pop();
    load.mockResolvedValue(models);
    const second = await catalog.get(signal(), true);
    expect(second.models).toHaveLength(3);
    expect(second.version).not.toBe(first.version);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('refuses stale data after expiry if upstream refresh fails', async () => {
    let now = 0;
    const adapter = new FakeAdapter();
    const load = vi.spyOn(adapter, 'listModels');
    const catalog = service(adapter, () => now);
    await catalog.get(signal());
    now = 60_001;
    load.mockRejectedValue(new Error('Unavailable'));
    await expect(catalog.get(signal())).rejects.toThrow('Unavailable');
    await expect(catalog.get(signal())).rejects.toThrow('Unavailable');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('rejects duplicate model IDs even from a non-proxy adapter', async () => {
    const adapter = new FakeAdapter();
    const models = await adapter.listModels(signal());
    vi.spyOn(adapter, 'listModels').mockResolvedValue([models[0]!, models[0]!]);
    await expect(service(adapter).get(signal())).rejects.toMatchObject({ publicError: { code: 'UPSTREAM_PROTOCOL' } });
  });
});
