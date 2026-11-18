import { expect, test } from '@playwright/test';
import { comparisonRequestSchema, modelCatalogSchema, streamEventSchema } from '@llm-compare/contracts';
import { formatEstimatedCost, formatSeconds } from '../../apps/web/src/features/comparison/metrics';

type SmokeWindow = Window & { liveComparisonBody?: Promise<string | null> };

test('compares two live models through the built interface in one streaming run', async ({ page, baseURL }) => {
  const desired = process.env.LLM_COMPARE_LIVE_MODELS?.split(',').map((id) => id.trim())
    ?? ['openai/gpt-5-mini', 'anthropic/claude-haiku-5.5'];
  expect(desired.length === 2 && new Set(desired).size === 2 && desired.every(Boolean),
    'LLM_COMPARE_LIVE_MODELS должен содержать два разных идентификатора через запятую').toBe(true);

  let comparisons = 0;
  const unexpectedRequests: string[] = [];
  // Never allow a browser request to reach the provider or submit a second paid run.
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseURL || url.pathname === '/api/retries') {
      unexpectedRequests.push(url.origin + url.pathname);
      await route.abort();
      return;
    }
    if (url.pathname === '/api/comparisons') {
      const input = comparisonRequestSchema.safeParse(request.postDataJSON());
      if (comparisons || request.method() !== 'POST' || !input.success || input.data.targets.length !== 2
        || input.data.targets.some((target) => !desired.includes(target.modelId))) {
        unexpectedRequests.push('Запрос сравнения вне рамок live-проверки');
        await route.fulfill({ status: 400, json: { code: 'INVALID_REQUEST', message: 'Проверка ожидает один запрос к выбранной паре моделей.', retryable: false } });
        return;
      }
      comparisons++;
    }
    await route.fallback();
  });

  // The app stops reading at run_completed, which can evict the body from Chrome's network inspector.
  // Start reading a copy in the page as soon as fetch resolves, leaving the app's stream intact.
  await page.addInitScript(() => {
    const capture = window as SmokeWindow;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const response = originalFetch(input, init);
      const url = new URL(input instanceof Request ? input.url : input, location.href);
      if (url.origin === location.origin && url.pathname === '/api/comparisons') {
        capture.liveComparisonBody ??= response.then((result) => result.clone().text()).catch(() => null);
      }
      return response;
    };
  });

  const [catalog] = await Promise.all([
    page.waitForResponse((response) => response.url() === `${baseURL}/api/models`),
    page.goto('/'),
  ]);
  expect(catalog.ok(), `Каталог CodeX Proxy недоступен (HTTP ${catalog.status()})`).toBe(true);
  const data = modelCatalogSchema.parse(await catalog.json());
  expect(data.mode).toBe('live');
  const models = desired.map((id) => {
    const model = data.models.find((item) => item.id === id);
    if (!model) throw new Error(`Модель ${id} отсутствует в актуальном каталоге. Укажите доступную пару в LLM_COMPARE_LIVE_MODELS.`);
    return model;
  });

  const initial = data.models.slice(0, 2);
  const input = page.getByRole('textbox', { name: 'Ваш вопрос' });
  await expect(input).toBeVisible();
  for (const model of models.filter((item) => !initial.some((selected) => selected.id === item.id))) {
    await page.getByRole('button', { name: 'Добавить модель', exact: true }).click();
    await page.getByRole('dialog').getByRole('button').filter({
      has: page.getByText(model.displayName, { exact: true }),
    }).filter({ has: page.getByText(model.provider, { exact: true }) }).click();
  }
  for (const model of initial.filter((item) => !desired.includes(item.id))) {
    await page.getByRole('button', { name: `Удалить ${model.displayName}`, exact: true }).click();
  }

  const run = page.waitForResponse((response) => response.url() === `${baseURL}/api/comparisons`);
  await input.fill('Напиши короткий ответ про кэш: заголовок Markdown и два пункта. Не больше 35 слов.');
  await input.press('Enter');
  const response = await run;
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('application/x-ndjson');
  const body = await page.evaluate(() => (window as SmokeWindow).liveComparisonBody ?? null);
  if (body === null) throw new Error('Не удалось прочитать копию потока сравнения в браузере.');
  const events = body.trim().split('\n').map((line) => streamEventSchema.parse(JSON.parse(line)));
  const results = events.flatMap((event) => event.type === 'model_result' ? [event.result] : []);
  expect(events.at(-1)?.type).toBe('run_completed');
  expect(results.map(({ modelId, status, error }) => ({ modelId, status, ...(error && { error: error.code }) })))
    .toEqual(expect.arrayContaining(desired.map((modelId) => ({ modelId, status: 'succeeded' }))));
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(events.some((event) => event.type === 'answer_delta' && event.attemptId === result.attemptId)).toBe(true);
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.metrics?.firstAnswerMs).toEqual(expect.any(Number));
    const model = models.find((item) => item.id === result.modelId)!;
    const card = page.getByRole('region', { name: `Ответ ${model.displayName}`, exact: true });
    await expect(card.locator('.markdown')).toHaveText(/\S/);
    await expect(card.locator('.answer-duration')).toHaveText(formatSeconds(result.totalMs));
    const metrics = result.metrics!;
    const tariff = model.pricing;
    if (tariff && metrics.inputTokens !== null && metrics.outputTokens !== null) {
      expect(metrics.costBasis?.pricing).toEqual(tariff);
      expect(metrics.cost).not.toBeNull();
      const estimate = (metrics.inputTokens * tariff.inputPerMillion + metrics.outputTokens * tariff.outputPerMillion) / 1_000_000;
      expect(Math.abs(metrics.cost! - estimate)).toBeLessThanOrEqual(4 * Number.EPSILON * estimate);
    } else expect(metrics.cost).toBeNull();
    await card.locator('summary').click();
    const firstData = metrics.firstEventMs === null ? null : formatSeconds(metrics.firstEventMs);
    const firstAnswer = metrics.firstAnswerMs === null ? null : formatSeconds(metrics.firstAnswerMs);
    await expect(card.locator('dl dd')).toHaveText([
      formatSeconds(result.totalMs),
      ...(firstData !== null && firstData !== firstAnswer ? [firstData] : []),
      firstAnswer ?? 'нет данных',
      metrics.inputTokens?.toLocaleString('ru-RU') ?? 'нет данных',
      metrics.outputTokens?.toLocaleString('ru-RU') ?? 'нет данных',
      metrics.cost === null ? 'нет данных' : formatEstimatedCost(metrics.cost),
    ]);
    if (result.reasoning && result.reasoningMs !== undefined) {
      await expect(card.getByRole('button', { name: /Thinking/ })).toContainText(formatSeconds(result.reasoningMs));
    }
    console.log(JSON.stringify({ model: result.modelId, totalMs: result.totalMs, ...result.metrics }));
  }
  await expect(page.getByText('Сравнение завершено.', { exact: true })).toBeVisible();
  expect(comparisons).toBe(1);
  expect(unexpectedRequests).toEqual([]);
});
