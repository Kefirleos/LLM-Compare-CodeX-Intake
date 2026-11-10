import { buildApp } from './app.js';
import { FakeAdapter } from './adapters/fake.js';
import { loadConfig } from './config/index.js';

try {
  const config = loadConfig();
  const app = buildApp(new FakeAdapter());
  await app.listen({ host: config.host, port: config.port });
  console.log(`LLM Compare API: http://${config.host}:${config.port} (mock)`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app.close(); });
  }
} catch {
  console.error('Не удалось запустить API. Проверьте HOST, PORT и LLM_MODE=mock.');
  process.exitCode = 1;
}
