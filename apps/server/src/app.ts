import Fastify from 'fastify';
import { modelCatalogSchema } from '@llm-compare/contracts';
import type { LlmAdapter } from './adapters/types.js';
import { registerComparisons } from './routes/comparisons.js';
import { AdapterError } from './adapters/error.js';
import { CatalogService } from './catalog/service.js';

export function buildApp(adapter: LlmAdapter, options: { attemptTimeoutMs?: number } = {}) {
  const app = Fastify({ bodyLimit: 256 * 1024, logger: false });
  const catalog = new CatalogService(adapter);
  app.addHook('onClose', async () => { catalog.close(); });

  app.get('/api/health', async () => ({ status: 'ok' as const }));
  app.get('/api/models', async (_request, reply) => {
    const controller = new AbortController();
    try {
      const query = _request.query as Record<string, unknown>;
      const snapshot = await catalog.get(controller.signal, query.refresh === '1');
      return modelCatalogSchema.parse({
        protocolVersion: 1, catalogVersion: snapshot.version, mode: adapter.mode, models: snapshot.models,
      });
    } catch (error) {
      if (error instanceof AdapterError) return reply.code(503).send(error.publicError);
      return reply.code(503).send({
        code: 'CATALOG_UNAVAILABLE', message: 'Каталог моделей временно недоступен.', retryable: true,
      });
    }
  });
  registerComparisons(app, adapter, options.attemptTimeoutMs ?? 10_000, catalog);
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({
    code: 'NOT_FOUND', message: 'Маршрут не найден.', retryable: false,
  }));
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (status === 413) return reply.code(413).send({
      code: 'PAYLOAD_TOO_LARGE', message: 'Запрос превышает допустимый размер.', retryable: false,
    });
    if (status === 400 || status === 415) return reply.code(status).send({
      code: 'INVALID_REQUEST', message: 'Ожидается корректный JSON-запрос.', retryable: false,
    });
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера.', retryable: false });
  });
  return app;
}
