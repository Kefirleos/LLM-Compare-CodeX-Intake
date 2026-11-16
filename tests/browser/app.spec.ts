import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

async function ready(page: Page) { await page.goto('/'); await expect(page.getByLabel('Ваш вопрос')).toBeVisible(); }
async function add(page: Page, name: string) {
  await page.getByRole('button', { name: 'Добавить модель', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(name) }).click();
}
async function compare(page: Page, prompt: string) { await page.getByLabel('Ваш вопрос').fill(prompt); await page.getByLabel('Ваш вопрос').press('Enter'); }
async function completed(page: Page) { await expect(page.locator('.run-status')).toHaveText('Сравнение завершено.'); }
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const button = await page.getByRole('button', { name: 'Сравнить', exact: true }).boundingBox();
  expect(button).not.toBeNull(); expect(button!.y + button!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
}
async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([]);
}

for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [1024, 768], [1440, 900]] as const) {
  test(`four columns, sticky headers, overflow and accessibility at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height }); await ready(page); await accessible(page);
    const viewport = await page.locator('.comparison-scroll').boundingBox();
    expect(viewport!.height).toBeGreaterThanOrEqual(height * .75);
    const history = page.getByRole('button', { name: 'История', exact: true });
    await expect(history).toHaveAttribute('aria-expanded', 'false');
    const composer = await page.locator('.composer-input').boundingBox();
    expect(height - (composer!.y + composer!.height)).toBeGreaterThanOrEqual(width <= 640 ? 13 : 24);
    await add(page, 'Медленный ответ'); await add(page, 'Ошибка');
    await expect(page.getByRole('button', { name: 'Добавить модель', exact: true })).toBeDisabled();
    await compare(page, '[fixture:long]'); await completed(page);
    await expect(page.locator('.answer-cell.is-selected .markdown h2').first()).toHaveText('Section 0');
    await noOverflow(page);
    const question = page.locator('.question');
    const questionBox = (await question.boundingBox())!;
    const promptBox = (await question.getByText('[fixture:long]', { exact: true }).boundingBox())!;
    const grid = (await page.locator('.comparison-grid').boundingBox())!;
    expect(questionBox.width).toBeCloseTo(grid.width, 0);
    expect(questionBox.height).toBeLessThan(48);
    expect(promptBox.x - questionBox.x).toBeLessThan(110);
    if (width === 390 || width === 1440) await page.screenshot({ path: info.outputPath(`question-${width}.png`) });
    await page.locator('.comparison-scroll').evaluate((element) => { element.scrollTop = 800; });
    const scrollBox = await page.locator('.comparison-scroll').boundingBox();
    const heading = await page.locator('.column-heading.is-selected').boundingBox();
    const tabsBox = width <= 1000 ? await page.getByRole('tablist').boundingBox() : null;
    expect(Math.abs(heading!.y - scrollBox!.y - (tabsBox?.height ?? 0))).toBeLessThan(3);
    if (width <= 1000) {
      const tabs = page.getByRole('tab'); await tabs.first().focus(); await tabs.first().press('End');
      await expect(tabs.last()).toHaveAttribute('aria-selected', 'true'); await expect(tabs.last()).toBeFocused();
      await tabs.last().press('Home'); await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    }
    await accessible(page); await page.screenshot({ path: info.outputPath(`layout-${width}.png`) });
    await history.click();
    const popover = page.getByRole('region', { name: 'История бесед' });
    await expect(popover.getByRole('button', { name: '[fixture:long]' })).toBeVisible();
    const before = await page.locator('.comparison-scroll').boundingBox();
    expect(before).toEqual(scrollBox);
    const popoverBox = await popover.boundingBox();
    expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
    expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(width);
    await accessible(page);
    await page.screenshot({ path: info.outputPath(`history-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(history).toBeFocused();
    await history.click();
    await page.getByLabel('Ваш вопрос').click();
    await expect(popover).toBeHidden();
  });
}

test('picker keyboard, focus return and IME/Shift+Enter', async ({ page }) => {
  await ready(page);
  const addButton = page.getByRole('button', { name: 'Добавить модель', exact: true }); await addButton.focus(); await addButton.press('Enter');
  await expect(page.getByRole('searchbox')).toBeFocused(); await page.getByRole('searchbox').fill('no such model');
  await accessible(page);
  await expect(page.getByText('Ничего не найдено.')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(addButton).toBeFocused();
  let posts = 0; page.on('request', (request) => { if (request.url().endsWith('/api/comparisons')) posts++; });
  const input = page.getByLabel('Ваш вопрос'); await input.fill('first'); await input.press('Shift+Enter'); await input.press('x');
  await expect(input).toHaveValue('first\nx');
  await input.dispatchEvent('compositionstart'); await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 }); await input.dispatchEvent('compositionend');
  expect(posts).toBe(0); await input.press('Enter'); await completed(page); expect(posts).toBe(1);
});

test('real worker reveals words, keeps DOM/focus/selection and blocks external Markdown resources', async ({ page, context }) => {
  const external: string[] = []; const failures: string[] = [];
  context.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:')) external.push(request.url()); });
  page.on('pageerror', (error) => failures.push(error.message));
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } }); });
  await ready(page);
  const observation = page.evaluate(() => new Promise<number[]>((resolve) => {
    const values: number[] = []; const start = performance.now(); let first = 0;
    const sample = () => {
      const text = document.querySelector('.answer-cell.is-selected .markdown > p')?.textContent ?? '';
      if (text.startsWith('word0')) { first ||= performance.now(); values.push(text.length); }
      if ((first && performance.now() - first > 800) || performance.now() - start > 5000) resolve(values); else requestAnimationFrame(sample);
    }; sample();
  }));
  await compare(page, '[fixture:stream]');
  const code = page.locator('.answer-cell.is-selected pre code').first(); await expect(code).toBeVisible();
  const samples = await observation;
  expect(new Set(samples).size).toBeGreaterThan(1);
  const copy = page.locator('.answer-cell.is-selected').getByRole('button', { name: 'Скопировать код' }); await copy.click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe('const value = 1;\n');
  const handle = await code.elementHandle();
  await code.evaluate((element) => { const range = document.createRange(); range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, 5); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
  await completed(page); await expect(page.locator('.answer-cell.is-selected .markdown')).toContainText('Browser fixture complete.');
  expect(await handle!.evaluate((element) => element === document.querySelector('.answer-cell.is-selected pre code'))).toBe(true);
  await expect(copy).toBeFocused(); expect(await page.evaluate(() => getSelection()!.toString())).toBe('const');
  await expect(page.getByRole('link', { name: 'Late link' }).first()).toHaveAttribute('href', 'https://example.com/docs');
  await expect(page.locator('.markdown img, .markdown script, .markdown iframe')).toHaveCount(0);
  await expect(page.locator('.markdown-fallback')).toHaveCount(0); expect(external).toEqual([]); expect(failures).toEqual([]);
});

test('Stop flushes the accepted tail and a hidden mobile model keeps receiving data', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page); await compare(page, '[fixture:stream]');
  await expect(page.locator('.answer-cell.is-selected pre code')).toBeVisible();
  const tabs = page.getByRole('tab'); await tabs.last().click();
  await expect(page.locator('.answer-cell.is-selected pre code')).toBeVisible();
  await page.getByRole('button', { name: 'Остановить', exact: true }).click();
  await expect(page.locator('.answer-cell.is-selected .markdown')).toContainText('partial');
  await expect(page.locator('.run-status')).toHaveText('Сравнение завершено.');
  await page.waitForTimeout(2700); await expect(page.locator('.markdown').filter({ hasText: 'Browser fixture complete.' })).toHaveCount(0);
  await noOverflow(page);
});

test('reload restores a partial checkpoint without resubmitting, then cross-tab conflicts stay local', async ({ page, context }) => {
  let posts = 0; context.on('request', (request) => { if (request.url().endsWith('/api/comparisons')) posts++; });
  const historyStatus = page.locator('.history-toolbar').getByRole('status', { includeHidden: true });
  await ready(page); await compare(page, '[fixture:stream]');
  await expect(page.locator('.answer-cell.is-selected pre code')).toBeVisible(); await expect(historyStatus).toHaveText('Сохранено на устройстве');
  await page.reload(); await expect(page.getByText(/Страница была закрыта до завершения ответа/).first()).toBeVisible();
  expect(posts).toBe(1); await expect(page.locator('.answer-cell.is-selected .markdown')).toContainText('partial');
  // The recovered attempt writes a new revision. Finish it before opening another tab.
  await expect(historyStatus).toHaveText('Сохранено на устройстве');
  const second = await context.newPage(); await ready(second); await expect(second.getByText(/Страница была закрыта/).first()).toBeVisible();
  const conflict = second.getByText(/Беседа изменена или удалена в другой вкладке/);
  await expect(conflict).toBeHidden();
  await page.getByLabel('Ваш вопрос').fill('updated in first tab');
  await expect(historyStatus).toHaveText('Сохранено на устройстве');
  await expect(conflict).toBeVisible();
  await second.reload(); await expect(second.getByLabel('Ваш вопрос')).toHaveValue('updated in first tab'); expect(posts).toBe(1);
});

test('reduced motion and a short mobile viewport keep the composer usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await ready(page);
  await page.getByLabel('Ваш вопрос').fill('line\n'.repeat(15)); await page.setViewportSize({ width: 390, height: 420 }); await noOverflow(page);
  await page.getByLabel('Ваш вопрос').fill('[fixture:stream]'); await page.getByLabel('Ваш вопрос').press('Enter');
  await expect(page.locator('.answer-cell.is-selected .markdown')).toContainText('partial');
  await page.getByRole('button', { name: 'Остановить', exact: true }).click(); await noOverflow(page);
});

test('isolates a model error and retries only that column', async ({ page }) => {
  const posts: { url: string; body: unknown }[] = [];
  page.on('request', (request) => { if (request.method() === 'POST' && /\/api\/(comparisons|retries)$/.test(request.url())) posts.push({ url: request.url(), body: request.postDataJSON() }); });
  await ready(page); await add(page, 'Медленный ответ'); await add(page, 'Ошибка');
  await compare(page, 'Question for all models'); await completed(page);
  const failed = page.locator('.answer-cell').last(); await expect(failed.getByRole('button', { name: 'Повторить ответ' })).toBeVisible();
  await expect(failed.locator('.timing-leaders')).toHaveCount(0);
  const successful = await page.locator('.answer-cell').first().locator('.markdown p').first().elementHandle();
  await failed.getByRole('button', { name: 'Повторить ответ' }).click(); await completed(page);
  expect(posts).toHaveLength(2); expect(posts[1]!.url).toContain('/api/retries');
  expect(posts[1]!.body).toMatchObject({ prompt: 'Question for all models', target: { modelId: 'mock-error' } });
  expect(posts[1]!.body).not.toHaveProperty('targets');
  expect(await successful!.evaluate((node) => node === document.querySelector('.answer-cell .markdown p'))).toBe(true);
});

test('four large streams keep draft entry and mobile switching available', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page); await add(page, 'Медленный ответ'); await add(page, 'Ошибка');
  await compare(page, '[fixture:stress]'); await expect(page.locator('.answer-cell.is-selected pre code')).toBeVisible();
  const start = Date.now(); await page.getByLabel('Ваш вопрос').fill('Draft entered while four responses are streaming');
  const entryMs = Date.now() - start;
  await info.attach('draft-entry-timing', { body: JSON.stringify({ entryMs, thresholdMs: 2000, environment: 'local automated browser; not a universal latency guarantee' }), contentType: 'application/json' });
  expect(entryMs).toBeLessThan(2000);
  await page.getByRole('tab').last().click(); await completed(page);
  await expect(page.getByLabel('Ваш вопрос')).toHaveValue('Draft entered while four responses are streaming');
  await expect(page.locator('.answer-cell.is-selected .markdown')).toContainText('End of stress.');
  await expect(page.locator('.markdown-fallback')).toHaveCount(0); await noOverflow(page);
});

test('clipboard denial leaves code readable', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Denied'); } } }); });
  await ready(page); await compare(page, '[fixture:stream]');
  const answer = page.locator('.answer-cell.is-selected'); await expect(answer.locator('pre code')).toBeVisible();
  await answer.getByRole('button', { name: 'Скопировать код' }).click();
  await expect(answer.getByText('Не удалось скопировать')).toBeVisible(); await expect(answer.locator('pre code')).toHaveText('const value = 1;\n');
  await page.getByRole('button', { name: 'Остановить', exact: true }).click();
});

test('Thinking remains separate, follows real phases and survives Stop', async ({ page }) => {
  await ready(page); await compare(page, '[fixture:thinking]');
  const answer = page.locator('.answer-cell').first(); const toggle = answer.getByRole('button', { name: /Thinking/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(answer.getByText('First reasoning segment.')).toBeVisible();
  await expect(answer.locator('.markdown')).toContainText('Answer segment.'); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(answer.getByText('First reasoning segment. Second reasoning segment.')).toBeVisible();
  await page.getByRole('button', { name: 'Остановить', exact: true }).click();
  await expect(toggle).toContainText('прервано'); await toggle.focus(); await toggle.press('Enter');
  await expect(answer.getByText('First reasoning segment. Second reasoning segment.')).toBeVisible();
  await expect(answer.locator('.markdown')).not.toContainText('reasoning');
});
