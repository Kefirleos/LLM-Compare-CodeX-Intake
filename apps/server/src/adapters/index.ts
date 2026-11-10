import type { loadConfig } from '../config/index.js';
import { FakeAdapter } from './fake.js';
import { CodexProxyAdapter } from './codex-proxy.js';

export function createAdapter(config: ReturnType<typeof loadConfig>) {
  return config.mode === 'mock' ? new FakeAdapter() : new CodexProxyAdapter(config.apiKey);
}
