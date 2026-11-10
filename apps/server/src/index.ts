import { buildApp } from './app.js';
import { createAdapter } from './adapters/index.js';
import { loadConfig } from './config/index.js';

try {
  const config = loadConfig();
  const app = buildApp(createAdapter(config));
  await app.listen({ host: config.host, port: config.port });
  console.log(`LLM Compare API: http://${config.host}:${config.port} (${config.mode})`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app.close(); });
  }
} catch {
  console.error('Не удалось запустить API. Проверьте HOST, PORT, LLM_MODE и наличие серверного ключа для live-режима.');
  process.exitCode = 1;
}
