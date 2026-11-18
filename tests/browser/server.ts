import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../../apps/server/src/app.js';
import { FakeAdapter } from '../../apps/server/src/adapters/fake.js';
import { firstChunk, secondChunk, longAnswer } from './fixtures.js';

// Dedicated loopback-only fixture server. It never loads configuration or an API key.
const adapter = new FakeAdapter();
const listModels = adapter.listModels.bind(adapter);
adapter.listModels = async (signal) => (await listModels(signal)).map((model, index) => ({
  ...model, pricing: { inputPerMillion: (index + 1) * 0.1, outputPerMillion: (index + 1) * 0.2, currency: 'USD' },
}));
const stream = adapter.stream.bind(adapter);
adapter.stream = async function* (input, signal) {
  if (input.prompt.startsWith('[fixture:usage]')) {
    yield 'A completed answer.';
    await delay(300, undefined, { signal });
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } };
    return;
  }
  if (input.prompt.startsWith('[fixture:stream]')) {
    yield firstChunk; await delay(2500, undefined, { signal }); yield secondChunk; return;
  }
  if (input.prompt.startsWith('[fixture:long]')) { yield longAnswer; return; }
  if (input.prompt.startsWith('[fixture:stress]')) {
    yield '# Large response\n\n```text\n' + 'value 👋\n'.repeat(8192);
    await delay(150, undefined, { signal }); yield 'more content\n'.repeat(8192);
    await delay(500, undefined, { signal }); yield '\n```\n\nEnd of stress.'; return;
  }
  if (input.prompt.startsWith('[fixture:thinking]')) {
    yield { type: 'reasoning_started' }; yield { type: 'reasoning_delta', text: 'First reasoning segment.' };
    await delay(800, undefined, { signal }); yield 'Answer segment.\n\n';
    await delay(800, undefined, { signal }); yield { type: 'reasoning_delta', text: ' Second reasoning segment.' };
    await delay(1200, undefined, { signal }); return;
  }
  yield* stream(input, signal);
};
const app = buildApp(adapter);
await app.listen({ host: '127.0.0.1', port: 4309 });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
