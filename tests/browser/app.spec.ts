import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { modelCatalogSchema } from '@llm-compare/contracts';

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

for (const width of [390, 1440]) {
  test(`answers expand smoothly with rendered content at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await ready(page);
    await compare(page, '[fixture:growing]');
    const viewport = page.locator('.comparison-viewport');
    const initialHeight = (await viewport.boundingBox())!.height;
    expect(initialHeight).toBeLessThan(500);
    await expect(page.locator('.answer-cell.is-selected .markdown')).toContainText('A short opening.');
    await page.screenshot({ path: info.outputPath('compact-response.png') });
    const samples = await page.evaluate(() => new Promise<number[]>((resolve) => {
      const heights: number[] = [];
      const start = performance.now();
      const sample = () => {
        heights.push(document.querySelector('.comparison-viewport')!.getBoundingClientRect().height);
        if (performance.now() - start > 1700) resolve(heights);
        else requestAnimationFrame(sample);
      };
      sample();
    }));
    expect(Math.max(...samples)).toBeGreaterThan(initialHeight + 80);
    expect(new Set(samples.map(Math.round)).size).toBeGreaterThan(4);
    await expect(page.locator('.answer-cell.is-selected .markdown h2').last()).toHaveText('Section 59');
    await expect(page.locator('.answer-cell.is-selected .markdown p').last()).toBeInViewport({ ratio: .95 });
    await expect(page.getByRole('button', { name: 'Остановить' })).toBeVisible();
    await completed(page);
    await noOverflow(page);
    await expect(page.getByText('End of the growing response.', { exact: true }).first()).toBeInViewport({ ratio: .95 });
    const composer = (await page.locator('.composer').boundingBox())!;
    expect(composer.y).toBeGreaterThan(800);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(viewport).toHaveCSS('transition-duration', '0s');
    await expect(viewport).toHaveCSS('animation-name', 'none');
  });
}

test('a follow-up moves to the new answers and leaves manual reading in place', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  await compare(page, '[fixture:long]');
  await completed(page);
  await compare(page, '[fixture:usage]');
  await completed(page);
  await expect(page.locator('.next-question')).toBeInViewport();
  await expect(page.locator('.continued-turn').first().locator('.markdown')).toBeInViewport();
  const scroll = page.locator('.comparison-scroll');
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
  await scroll.evaluate((element) => { element.scrollTop = 0; });
  await page.getByLabel('Ваш вопрос').fill('Draft while reading the first answer');
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
  await noOverflow(page);
});

test('scrolling up during a follow-up lets the user keep reading earlier text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  await compare(page, '[fixture:long]');
  await completed(page);
  await compare(page, '[fixture:growing] follow-up');

  const scroll = page.locator('.comparison-scroll');
  await expect(page.locator('.next-question')).toBeInViewport();
  const answer = page.locator('.continued-turn.is-selected .markdown');
  await expect(answer.getByRole('heading', { name: 'Section 59', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Остановить' })).toBeVisible();
  await scroll.hover();
  const position = () => scroll.evaluate((element) => element.scrollTop);
  const before = await position();
  await page.mouse.wheel(0, -700);
  await expect.poll(position).toBeLessThan(before - 650);
  const paused = await position();

  await completed(page);
  const tail = answer.getByText('End of the growing response.', { exact: true });
  await expect(tail).toBeAttached();
  await expect(tail).not.toBeInViewport();
  expect(Math.abs(await position() - paused)).toBeLessThan(35);
});

for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [1024, 768], [1440, 900]] as const) {
  test(`four columns, sticky headers, overflow and accessibility at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height }); await ready(page); await accessible(page);
    await expect(page.getByRole('heading', { name: 'Новое сравнение' })).toBeVisible();
    await expect(page.locator('.comparison-grid')).toHaveCount(0);
    const history = page.getByRole('button', { name: 'История', exact: true });
    await expect(history).toHaveAttribute('aria-expanded', 'false');
    const composer = await page.locator('.composer-input').boundingBox();
    expect(composer!.y).toBeGreaterThan(height * .2);
    await noOverflow(page);
    await add(page, 'Медленный ответ'); await add(page, 'Ошибка');
    await expect(page.getByRole('button', { name: 'Добавить модель', exact: true })).toHaveCount(0);
    await compare(page, '[fixture:long]'); await completed(page);
    await expect(page.locator('.answer-cell.is-selected .markdown h2').first()).toHaveText('Section 0');
    await expect.poll(() => page.locator('.workspace').evaluate((element) => element.getAnimations({ subtree: true })
      .filter((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity).length)).toBe(0);
    await expect(page.locator('.answer-cell.is-selected .markdown p').last()).toBeInViewport({ ratio: .95 });
    const scroll = page.locator('.comparison-scroll');
    const viewport = page.locator('.comparison-viewport');
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(viewport).not.toHaveAttribute('data-more-below', '');
    await scroll.evaluate((element) => { element.scrollTop = 0; });
    await expect(viewport).toHaveAttribute('data-more-below', '');
    await noOverflow(page);
    const question = page.locator('.question-bar');
    const questionBox = (await question.boundingBox())!;
    const board = (await page.locator('.comparison-board').boundingBox())!;
    const sticky = width <= 1000 ? page.locator('.mobile-model-bar') : page.locator('.desktop-models');
    const headerBox = (await sticky.boundingBox())!;
    expect(questionBox.width).toBeLessThan(board.width * .9);
    expect(questionBox.x + questionBox.width).toBeCloseTo(board.x + board.width, 0);
    if (width > 1000) expect(questionBox.y).toBeGreaterThan(headerBox.y + headerBox.height);
    else expect(questionBox.y + questionBox.height).toBeLessThan(headerBox.y);
    if (width === 390 || width === 1440) await page.screenshot({ path: info.outputPath(`question-${width}.png`) });
    await expect(page.locator('.model-add-column')).toHaveCount(0);
    await scroll.evaluate((element) => { element.scrollTop = 800; });
    const scrollBox = await scroll.boundingBox();
    const stickyBox = await sticky.boundingBox();
    expect(Math.abs(stickyBox!.y - scrollBox!.y)).toBeLessThan(3);
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

test('opens the picker from the entire right-hand column and keeps its anchor visible on scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  await compare(page, '[fixture:long]');
  await completed(page);
  const addButton = page.getByRole('button', { name: 'Добавить модель', exact: true });
  const scroll = page.locator('.comparison-scroll');
  await expect(page.locator('.answer-cell .markdown h2').last()).toHaveText('Section 59');
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(400);
  await scroll.evaluate((element) => { element.scrollTop = 400; });
  const viewport = (await scroll.boundingBox())!;
  const anchor = (await addButton.locator('.model-add-anchor').boundingBox())!;
  expect(Math.abs(anchor.y - viewport.y)).toBeLessThan(3);
  const clickY = viewport.y + viewport.height * .75;
  expect(clickY).toBeGreaterThan(anchor.y + anchor.height + 100);
  await page.mouse.click(anchor.x + anchor.width / 2, clickY);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('data-placement', 'below');
  const picker = (await dialog.boundingBox())!;
  expect(picker.x + picker.width).toBeCloseTo(anchor.x + anchor.width, 0);
  expect(picker.y).toBeCloseTo(anchor.y + anchor.height + 8, 0);
  await page.mouse.click(10, 80);
  await expect(dialog).toHaveCount(0);
  await expect(addButton).toBeFocused();
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(400);
  await addButton.press('Enter');
  await dialog.getByRole('button', { name: /Медленный ответ/ }).click();
  await expect(page.locator('.comparison-grid .answer-cell')).toHaveCount(3);
  await expect(page.getByRole('region', { name: /Ответ Демо · Медленный ответ/ })).toContainText('начинается со следующего вопроса');
  await expect(addButton).toBeFocused();
});

test('mobile controls follow the selected tab and the form stays at the bottom after a short answer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const refresh = page.getByRole('button', { name: 'Обновить модели' });
  await expect(refresh).toHaveCount(0);
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await expect(page.getByText('Сохранённых бесед пока нет.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Удалить беседу|Очистить историю/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await compare(page, '[fixture:usage]');
  await completed(page);
  await expect(refresh).toBeVisible();
  await expect.poll(async () => {
    const box = (await page.locator('.composer').boundingBox())!;
    return Math.round(box.y + box.height);
  }).toBe(844);
  const addButton = page.locator('.mobile-model-switch').getByRole('button', { name: 'Добавить модель' });
  await addButton.click();
  await page.getByRole('dialog').getByRole('button', { name: /Медленный ответ/ }).click();
  const tabs = page.getByRole('tab');
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  const remove = page.locator('.mobile-model-heading').getByRole('button', { name: /Удалить.*Медленный ответ/ });
  await expect(remove).toBeVisible();
  await expect(page.getByRole('tabpanel')).toContainText('начинается со следующего вопроса');
  await remove.click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.last()).toBeFocused();
  await expect(page.locator('.mobile-model-heading').getByRole('button', { name: /^Удалить/ })).toHaveCount(0);
  await expect(addButton).toBeEnabled();
  await page.getByRole('button', { name: 'Новое сравнение' }).click();
  await expect(refresh).toHaveCount(0);
  await expect(page.getByLabel('Ваш вопрос')).toBeFocused();
});

test('the composer shows a single keyboard focus border around the card', async ({ page }) => {
  await ready(page);
  const input = page.getByLabel('Ваш вопрос');
  const frame = page.locator('.composer-input');
  const label = page.locator('.composer-label');
  const focusColor = 'rgb(136, 150, 143)';

  await input.focus();
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS('outline-style', 'none');
  await expect(label).toHaveCSS('border-top-color', focusColor);
  await expect(frame).toHaveCSS('border-bottom-color', focusColor);

  await compare(page, '[fixture:usage]');
  await completed(page);
  await input.focus();
  await expect(input).toHaveCSS('outline-style', 'none');
  await expect(frame).toHaveCSS('border-bottom-color', focusColor);
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(input).toHaveCSS('outline-style', 'solid');
});

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
  const answer = page.locator('.answer-cell.is-selected');
  const footnote = answer.locator('a[data-footnote-ref]');
  const destination = (await footnote.getAttribute('href'))!;
  const referenceId = (await footnote.getAttribute('id'))!;
  await expect(answer.locator(destination)).toContainText('Browser footnote content.');
  await footnote.click();
  await expect(page).toHaveURL((url) => url.hash === destination);
  await answer.locator('a[data-footnote-backref]').click();
  await expect(page).toHaveURL((url) => url.hash === '#' + referenceId);
  await expect(page.locator('.markdown img, .markdown script, .markdown iframe')).toHaveCount(0);
  await expect(page.locator('.markdown-fallback')).toHaveCount(0); expect(external).toEqual([]); expect(failures).toEqual([]);
});

test.describe('touch controls', () => {
  test.use({ hasTouch: true });

  test('Stop flushes the accepted tail and a hidden mobile model keeps receiving data', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await ready(page); await compare(page, '[fixture:stream]');
    await expect(page.locator('.answer-cell.is-selected pre code')).toBeVisible();
    await expect(page.locator('.context-note')).toHaveCount(0);
    const tabs = page.getByRole('tab'); await tabs.last().tap();
    await expect(page.locator('.answer-cell.is-selected pre code')).toBeVisible();
    await page.getByRole('button', { name: 'Остановить', exact: true }).tap();
    await expect(page.locator('.answer-cell.is-selected .markdown')).toContainText('partial');
    await expect(page.locator('.run-status')).toHaveText('Сравнение остановлено.');
    await expect(page.getByLabel('Ваш вопрос')).not.toBeFocused();
    await page.waitForTimeout(2700); await expect(page.locator('.markdown').filter({ hasText: 'Browser fixture complete.' })).toHaveCount(0);
    await noOverflow(page);
  });
});

test('reload restores a partial checkpoint without resubmitting, then cross-tab conflicts stay local', async ({ page, context }) => {
  let posts = 0; context.on('request', (request) => { if (request.url().endsWith('/api/comparisons')) posts++; });
  const historyStatus = page.locator('.history-toolbar').getByRole('status', { includeHidden: true });
  await ready(page); await compare(page, '[fixture:stream]');
  await expect(page.locator('.answer-cell.is-selected pre code')).toBeVisible(); await expect(historyStatus).toHaveText('Сохранено на устройстве');
  await page.reload(); await expect(page.getByText(/Страница была закрыта до завершения ответа/).first()).toBeVisible();
  await expect(page.locator('.run-status')).toHaveText('Сравнение прервано.');
  expect(posts).toBe(1); await expect(page.locator('.answer-cell.is-selected .markdown')).toContainText('partial');
  // Loading an interrupted checkpoint leaves its saved revision intact.
  await expect(historyStatus).toHaveText('Сохранено на устройстве');
  const second = await context.newPage(); await ready(second); await expect(second.getByText(/Страница была закрыта/).first()).toBeVisible();
  const conflict = second.getByText(/Беседа изменена или удалена в другой вкладке/);
  await expect(conflict).toBeHidden();
  await page.getByLabel('Ваш вопрос').fill('updated in first tab');
  await expect(historyStatus).toHaveText('Сохранено на устройстве');
  await expect(conflict).toBeVisible();
  await second.reload(); await expect(second.getByLabel('Ваш вопрос')).toHaveValue('updated in first tab'); expect(posts).toBe(1);
});

test('keeps the refreshed catalog across conversations and recovers from a startup catalog error', async ({ page }) => {
  const initial = page.waitForResponse((response) => response.url().endsWith('/api/models') && response.ok());
  await ready(page);
  const catalog = modelCatalogSchema.parse(await (await initial).json());
  let currentCatalog = catalog;
  let offline = false;
  await page.route(/\/api\/models(?:\?refresh=1)?$/, async (route) => {
    if (offline) await route.fulfill({ status: 503, json: { code: 'CATALOG_UNAVAILABLE', message: 'Каталог временно недоступен.', retryable: true } });
    else await route.fulfill({ json: currentCatalog });
  });

  for (const prompt of ['Первая беседа', 'Вторая беседа']) {
    await compare(page, prompt);
    await completed(page);
    await expect(page.locator('.history-toolbar').getByRole('status', { includeHidden: true })).toHaveText('Сохранено на устройстве');
    if (prompt === 'Первая беседа') await page.getByRole('button', { name: 'Новое сравнение' }).click();
  }

  currentCatalog = { ...catalog, models: catalog.models.slice(1) };
  const refresh = page.getByRole('button', { name: 'Обновить модели' });
  const unavailable = page.getByText(/Выбранная модель больше недоступна/);
  await refresh.click();
  await expect(unavailable).toBeVisible();
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await page.getByRole('button', { name: 'Первая беседа', exact: true }).click();
  await expect(page.locator('.question-bar p')).toHaveText('Первая беседа');
  const input = page.getByLabel('Ваш вопрос');
  const send = page.getByRole('button', { name: 'Сравнить', exact: true });
  await input.fill('Черновик продолжения');
  await expect(unavailable).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(page.locator('.history-toolbar').getByRole('status', { includeHidden: true })).toHaveText('Сохранено на устройстве');

  offline = true;
  await page.reload();
  const offlineAlert = page.getByRole('alert').filter({ hasText: 'Каталог временно недоступен.' });
  await expect(page.locator('.question-bar p')).toHaveText('Первая беседа');
  await expect(offlineAlert).toBeVisible();
  await expect(refresh).toHaveCount(0);
  await expect(page.getByText('Для сравнения нужны хотя бы две доступные модели.')).toHaveCount(0);
  await expect(send).toBeDisabled();
  offline = false;
  currentCatalog = catalog;
  await offlineAlert.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(offlineAlert).toHaveCount(0);
  await expect(input).toHaveValue('Черновик продолжения');
  await expect(send).toBeEnabled();
  await expect(refresh).toBeVisible();
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

test('shows reported tokens and an estimated cost, preserving both after reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let posts = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/comparisons')) posts++; });
  await ready(page);
  await compare(page, '[fixture:usage]');
  await completed(page);
  const answers = page.locator('.answer-cell');
  await expect(answers.first().locator('.answer-cost')).toHaveText('≈ 0,000014 USD');
  const chevron = answers.first().locator('.metrics-chevron');
  const closedDirection = await chevron.evaluate((element) => getComputedStyle(element).transform);
  await answers.first().getByText('Метрики', { exact: true }).click();
  await expect(chevron).not.toHaveCSS('transform', closedDirection);
  await expect(answers.first().getByText('Первый фрагмент ответа', { exact: true })).toBeVisible();
  await expect(answers.first().getByText('Первый фрагмент Thinking', { exact: true })).toHaveCount(0);
  await expect(answers.first().locator('dl')).toContainText('100');
  await expect(answers.first().locator('dl')).toContainText('20');
  await expect(answers.first().locator('dl')).toContainText('0,000014 USD');
  await expect(answers.first().getByText('Наименьшая оценка стоимости', { exact: true })).toBeVisible();
  await expect(answers.first().getByText(/без скидок за кэш/)).toBeVisible();
  await expect(page.locator('.history-toolbar').getByRole('status', { includeHidden: true })).toHaveText('Сохранено на устройстве');
  await page.reload();
  await answers.first().getByText('Метрики', { exact: false }).first().click();
  await expect(answers.first().locator('dl')).toContainText('0,000014 USD');
  expect(posts).toBe(1);
});
