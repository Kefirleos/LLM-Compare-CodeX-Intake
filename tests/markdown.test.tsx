// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownAnswer, MarkdownBoundary, safeMarkdownUrl } from '../apps/web/src/features/markdown/MarkdownAnswer';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Markdown rendering', () => {
  it('preserves the exact latest raw text when a browser worker cannot start', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('Worker denied'); } });
    const text = '<script>do not execute</script>\n  исходный текст';
    const view = render(<MarkdownAnswer text={text} finalized={false} />);
    await screen.findByText('Не удалось обновить форматирование. Исходный ответ сохранён.');
    expect(document.querySelector('.markdown-fallback pre')?.textContent).toBe(text);
    view.rerender(<MarkdownAnswer text={text + '\nещё текст'} finalized />);
    expect(document.querySelector('.markdown-fallback pre')?.textContent).toBe(text + '\nещё текст');
    expect(document.querySelector('script')).toBeNull();
  });
  it('keeps stable DOM, clipboard focus and selection when a later block grows', () => {
    const first = '# Stable\n\n```js\nconst value = 1;\n```\n\nTail';
    const view = render(<MarkdownAnswer text={first} finalized={false} />);
    const heading = screen.getByRole('heading', { name: 'Stable' });
    const code = document.querySelector('pre code')!;
    const button = screen.getByRole('button', { name: 'Скопировать код' });
    button.focus();
    const range = document.createRange();
    range.setStart(code.firstChild!, 0); range.setEnd(code.firstChild!, 5);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    view.rerender(<MarkdownAnswer text={first + ' grows\n\n## New'} finalized={false} />);
    expect(screen.getByRole('heading', { name: 'Stable' })).toBe(heading);
    expect(document.querySelector('pre code')).toBe(code);
    expect(document.activeElement).toBe(button);
    expect(window.getSelection()!.toString()).toBe('const');
    expect(screen.getByRole('heading', { name: 'New' })).toBeTruthy();
  });

  it('updates a late reference while preserving an unrelated paragraph', () => {
    const first = '[link][ref]\n\nIndependent.\n\n';
    const view = render(<MarkdownAnswer text={first} finalized={false} />);
    const independent = screen.getByText('Independent.');
    expect(screen.queryByRole('link')).toBeNull();
    view.rerender(<MarkdownAnswer text={first + '[ref]: https://example.com'} finalized />);
    expect(screen.getByRole('link', { name: 'link' }).getAttribute('href')).toBe('https://example.com');
    expect(screen.getByText('Independent.')).toBe(independent);
  });

  it('renders headings, nested lists, quotes, GFM tables, task lists and inline code', () => {
    render(<MarkdownAnswer text={'# Заголовок\n\nПодзаголовок\n---\n\n**Жирный** и *курсив*, ~~удалено~~, `inline`.\n\n- Первый\n  - Вложенный\n\n1. Один\n2. Два\n\n> Цитата\n\n| Имя | Значение |\n| --- | --- |\n| Режим | Демо |\n\n- [x] Готово\n'} />);
    expect(screen.getByRole('heading', { name: 'Заголовок', level: 1 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Подзаголовок', level: 2 })).toBeTruthy();
    expect(document.querySelector('strong')?.textContent).toBe('Жирный');
    expect(document.querySelector('em')?.textContent).toBe('курсив');
    expect(document.querySelector('del')?.textContent).toBe('удалено');
    expect(document.querySelector('ul ul')?.textContent).toContain('Вложенный');
    expect(document.querySelector('ol')?.children).toHaveLength(2);
    expect(document.querySelector('blockquote')?.textContent).toContain('Цитата');
    expect(screen.getByRole('table')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('ignores raw HTML and replaces images without creating resource requests', () => {
    const { container } = render(<MarkdownAnswer text={'<script>alert(1)</script>\n\n<img src="https://tracking.invalid/raw" onerror="alert(1)">\n\n![Схема](https://tracking.invalid/image.png)\n\n<iframe src="https://tracking.invalid/frame"></iframe>'} />);
    expect(container.querySelector('script, img, iframe, link, video, audio')).toBeNull();
    expect(screen.getByText('Изображение не загружено: Схема')).toBeTruthy();
    expect(container.innerHTML).not.toContain('tracking.invalid');
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('renders safe external links with protected new tabs and drops dangerous links', () => {
    render(<MarkdownAnswer text={'[Документация](https://example.com/docs) [Опасная](javascript:alert%281%29) [Почта](mailto:a@example.com) [Файл](file:///etc/passwd)'} />);
    const link = screen.getByRole('link', { name: 'Документация' });
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText('Опасная')).toBeTruthy();
  });

  it('copies exact code text, preserving Unicode, spaces and line breaks', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
    const code = 'const ответ = "<script>текст</script>";\n  console.log(ответ);\n';
    render(<MarkdownAnswer text={'```unknown-language\n' + code + '```'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать код' }));
    await screen.findByText('Скопировано');
    expect(write).toHaveBeenCalledWith(code);
    expect(document.querySelector('pre code')?.textContent).toBe(code);
    expect(document.querySelector('script')).toBeNull();
  });

  it('shows clipboard denial without losing code content', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    render(<MarkdownAnswer text={'```\nconsole.log(1);\n```'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать код' }));
    await screen.findByText('Не удалось скопировать');
    expect(document.querySelector('pre code')?.textContent).toBe('console.log(1);\n');
  });

  it('isolates rendering failures, preserves raw text and recovers for a new answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never { throw new Error('Renderer failed'); }
    const raw = '<script>не выполнять</script>\n  исходный текст';
    const view = render(<MarkdownBoundary text={raw}><Broken /></MarkdownBoundary>);
    expect(document.querySelector('pre')?.textContent).toBe(raw);
    expect(document.querySelector('script')).toBeNull();
    view.rerender(<MarkdownBoundary text="Новый ответ"><p>Новый ответ</p></MarkdownBoundary>);
    await waitFor(() => expect(screen.queryByText(/Не удалось отобразить форматирование/)).toBeNull());
    expect(screen.getByText('Новый ответ')).toBeTruthy();
  });
});

describe('Markdown URL policy', () => {
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,test', 'vbscript:test', 'file:///tmp/a', '//tracking.invalid/a', '\\tracking.invalid', 'https://user:password@example.com', 'https:example.com', 'java\nscript:alert(1)', ' https://example.com'])('blocks %s', (url) => {
    expect(safeMarkdownUrl(url)).toBeUndefined();
  });
  it.each(['https://example.com/a', 'http://example.com', '#section', '/guide', './guide', '../guide', 'guide/page?lang=ru'])('allows %s', (url) => {
    expect(safeMarkdownUrl(url)).toBe(url);
  });
  it('never allows image sources', () => {
    expect(safeMarkdownUrl('https://example.com/image.png', 'src')).toBeUndefined();
  });
});
