import { modelCatalogSchema, publicErrorSchema } from '@llm-compare/contracts';

export async function fetchCatalog(signal: AbortSignal, refresh = false) {
  const response = await fetch(refresh ? '/api/models?refresh=1' : '/api/models', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = publicErrorSchema.safeParse(body);
    throw new Error(error.success ? error.data.message : 'Каталог моделей недоступен. Попробуйте ещё раз.');
  }
  return modelCatalogSchema.parse(body);
}
