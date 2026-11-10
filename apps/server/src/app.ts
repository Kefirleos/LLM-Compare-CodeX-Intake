import Fastify from 'fastify';
import { modelCatalogSchema } from '@llm-compare/contracts';
import type { LlmAdapter } from './adapters/types.js';

export function buildApp(adapter: LlmAdapter) {
  const app = Fastify({ bodyLimit: 256 * 1024, logger: false });

  app.get('/api/health', async () => ({ status: 'ok' as const }));
  app.get('/api/models', async (_request, reply) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const models = await adapter.listModels(controller.signal);
      return modelCatalogSchema.parse({
        protocolVersion: 1, catalogVersion: 'mock-v1', mode: 'mock', models,
      });
    } catch {
      return reply.code(503).send({
        code: 'CATALOG_UNAVAILABLE', message: 'Каталог моделей временно недоступен.', retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({
    code: 'NOT_FOUND', message: 'Маршрут не найден.', retryable: false,
  }));
  app.setErrorHandler((_error, _request, reply) => reply.code(500).send({
    code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера.', retryable: false,
  }));
  return app;
}
