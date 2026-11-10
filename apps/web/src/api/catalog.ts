import { modelCatalogSchema } from '@llm-compare/contracts';

export async function fetchCatalog(signal: AbortSignal) {
  const response = await fetch('/api/models', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error('Каталог моделей недоступен. Попробуйте ещё раз.');
  return modelCatalogSchema.parse(await response.json());
}
