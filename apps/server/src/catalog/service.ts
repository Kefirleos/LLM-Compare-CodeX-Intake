import { createHash } from 'node:crypto';
import { modelCatalogSchema } from '@llm-compare/contracts';
import type { ModelDescriptor } from '@llm-compare/contracts';
import type { LlmAdapter } from '../adapters/types.js';
import { AdapterError } from '../adapters/error.js';
import { withDeadline } from '../generation/deadline.js';

interface CatalogSnapshot { models: ModelDescriptor[]; version: string }

export class CatalogService {
  private cached: { snapshot: CatalogSnapshot; expiresAt: number } | null = null;
  private pending: Promise<CatalogSnapshot> | null = null;
  private lifetime = new AbortController();

  constructor(private readonly adapter: LlmAdapter, private readonly now = Date.now) {}

  async get(signal: AbortSignal, force = false): Promise<CatalogSnapshot> {
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (!force && this.cached && this.cached.expiresAt > this.now()) return structuredClone(this.cached.snapshot);
    if (!this.pending) {
      this.pending = this.refresh().finally(() => { this.pending = null; });
    }
    // A caller can stop waiting without cancelling a refresh used by other callers.
    const pending = this.pending;
    return structuredClone(await withDeadline(() => pending, signal, 5000));
  }

  private async refresh(): Promise<CatalogSnapshot> {
    const models = await withDeadline((signal) => this.adapter.listModels(signal), this.lifetime.signal, 5000);
    const parsed = modelCatalogSchema.safeParse({ protocolVersion: 1, catalogVersion: 'validation', mode: this.adapter.mode, models });
    if (!parsed.success || new Set(parsed.data.models.map((model) => model.id)).size !== models.length) {
      throw new AdapterError({ code: 'UPSTREAM_PROTOCOL', message: 'Каталог моделей имеет неверный формат.', retryable: true });
    }
    const version = createHash('sha256').update(JSON.stringify(parsed.data.models)).digest('hex').slice(0, 16);
    const snapshot = { models: parsed.data.models, version };
    this.cached = { snapshot, expiresAt: this.now() + 60_000 };
    return snapshot;
  }

  close() { this.lifetime.abort(); this.cached = null; }
}
