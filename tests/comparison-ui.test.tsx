// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonRequest, ComparisonResponse, RetryRequest } from '@llm-compare/contracts';
import { FakeAdapter } from '../apps/server/src/adapters/fake.js';
import { Comparison } from '../apps/web/src/features/comparison/Comparison';
import { Composer } from '../apps/web/src/features/composer/Composer';
import { sendComparison } from '../apps/web/src/api/comparisons';
import { fetchCatalog } from '../apps/web/src/api/catalog';

vi.mock('../apps/web/src/api/comparisons', () => ({ sendComparison: vi.fn() }));
vi.mock('../apps/web/src/api/catalog', () => ({ fetchCatalog: vi.fn() }));
const send = vi.mocked(sendComparison);
const fetchModels = vi.mocked(fetchCatalog);
let mobile = false;
beforeEach(() => {
  mobile = false;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

async function mount() {
  const models = await new FakeAdapter().listModels(new AbortController().signal);
  return render(<StrictMode><Comparison catalog={{ protocolVersion: 1, catalogVersion: 'test', mode: 'mock', models }} /></StrictMode>);
}
function responseFor(input: ComparisonRequest | RetryRequest, failSecond = false): ComparisonResponse {
  const targets = 'targets' in input ? input.targets : [input.target];
  return {
    protocolVersion: 1, runId: input.runId, conversationId: input.conversationId, turnId: input.turnId,
    results: targets.map((target, index) => index === 1 && failSecond
      ? { columnId: target.columnId, modelId: target.modelId, attemptId: target.attemptId, status: 'failed', text: '', totalMs: 21, error: { code: 'GENERATION_FAILED', message: 'Тестовая ошибка', retryable: true } }
      : { columnId: target.columnId, modelId: target.modelId, attemptId: target.attemptId, status: 'succeeded', text: `Ответ ${target.modelId}`, totalMs: 20, error: null }),
  };
}

describe('comparison interface', () => {
  it('starts with two models and prevents removing either one', async () => {
    await mount();
    const remove = screen.getAllByRole('button', { name: /^Удалить/ }) as HTMLButtonElement[];
    expect(remove).toHaveLength(2);
    expect(remove.every((button) => button.disabled)).toBe(true);
    expect((screen.getByRole('button', { name: 'Сравнить' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('searches the dialog, prevents duplicates, caps selection at four, and restores focus', async () => {
    await mount();
    const user = userEvent.setup();
    const add = screen.getByRole('button', { name: 'Добавить модель' });
    await user.click(add);
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByRole('button', { name: /Краткий ответ/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole('searchbox'), 'несуществующая');
    expect(screen.getByText('Ничего не найдено.')).toBeTruthy();
    await user.clear(screen.getByRole('searchbox'));
    await user.click(within(dialog).getByRole('button', { name: /Медленный ответ/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(add);
    await user.click(add);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Ошибка/ }));
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('button', { name: /^Удалить/ })).toHaveLength(4);
    expect(document.activeElement).toBe(screen.getByLabelText('Ваш вопрос'));
  });

  it('blocks duplicate submits, locks model selection and preserves a draft typed during generation', async () => {
    let finish!: (value: ComparisonResponse) => void;
    send.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    const user = userEvent.setup();
    const textarea = screen.getByLabelText('Ваш вопрос');
    await user.type(textarea, 'Первый вопрос');
    const form = textarea.closest('form')!;
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(send).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Добавить модель' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(textarea, 'Новый черновик');
    await act(async () => finish(responseFor(send.mock.calls[0]![0])));
    expect((textarea as HTMLTextAreaElement).value).toBe('Новый черновик');
    expect(screen.getByText('Ответ mock-clear')).toBeTruthy();
    expect(screen.getByText('Ответ mock-detailed')).toBeTruthy();
  });

  it('retries only the failed column and keeps the successful answer and original question', async () => {
    send.mockImplementation(async (input) => responseFor(input, 'targets' in input));
    await mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Исходный вопрос');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await screen.findByText('Тестовая ошибка');
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Новый черновик');
    await user.click(screen.getByRole('button', { name: 'Повторить ответ' }));
    await screen.findByText('Ответ mock-detailed');
    expect(screen.getByText('Ответ mock-clear')).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(2);
    const retry = send.mock.calls[1]![0] as RetryRequest;
    expect(retry.prompt).toBe('Исходный вопрос');
    expect(retry.target.modelId).toBe('mock-detailed');
    expect('targets' in retry).toBe(false);
    expect((screen.getByLabelText('Ваш вопрос') as HTMLTextAreaElement).value).toBe('Новый черновик');
  });

  it('keeps a changed draft after transport failure and allows explicit restoration', async () => {
    let fail!: (reason: Error) => void;
    send.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await mount();
    const user = userEvent.setup();
    const textarea = screen.getByLabelText('Ваш вопрос');
    await user.type(textarea, 'Отправленный вопрос');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await user.type(textarea, 'Другой текст');
    await act(async () => fail(new TypeError('Failed to fetch')));
    expect((textarea as HTMLTextAreaElement).value).toBe('Другой текст');
    await user.click(screen.getByRole('button', { name: 'Восстановить отправленный вопрос' }));
    expect((textarea as HTMLTextAreaElement).value).toBe('Отправленный вопрос');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('switches mobile tabs with arrows without restarting requests', async () => {
    mobile = true;
    send.mockImplementation(async (input) => responseFor(input));
    await mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Вопрос');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await screen.findByText('Ответ mock-clear');
    const tabs = screen.getAllByRole('tab');
    tabs[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('preserves answers when refreshing the catalog and replaces missing models only on explicit reset', async () => {
    send.mockImplementation(async (input) => responseFor(input));
    const models = await new FakeAdapter().listModels(new AbortController().signal);
    fetchModels.mockResolvedValue({ protocolVersion: 1, catalogVersion: 'new', mode: 'mock', models: models.slice(2) });
    await mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Вопрос');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await screen.findByText('Ответ mock-clear');
    await user.click(screen.getByRole('button', { name: 'Обновить модели' }));
    await screen.findByText(/Выбранная модель больше недоступна/);
    expect(screen.getByText('Ответ mock-clear')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Сравнить' }) as HTMLButtonElement).disabled).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Новое сравнение' }));
    expect(screen.queryByText('Ответ mock-clear')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Демо · Медленный ответ' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Демо · Ошибка' })).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retains answers on catalog failure and blocks new requests until refresh succeeds', async () => {
    send.mockImplementation(async (input) => responseFor(input));
    fetchModels.mockRejectedValue(new Error('Network failed'));
    await mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Вопрос');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await screen.findByText('Ответ mock-clear');
    await user.click(screen.getByRole('button', { name: 'Обновить модели' }));
    await screen.findByText(/Не удалось обновить каталог/);
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Следующий вопрос');
    expect((screen.getByRole('button', { name: 'Сравнить' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Ответ mock-clear')).toBeTruthy();
    const models = await new FakeAdapter().listModels(new AbortController().signal);
    fetchModels.mockResolvedValue({ protocolVersion: 1, catalogVersion: 'fresh', mode: 'mock', models });
    await user.click(screen.getByRole('button', { name: 'Обновить модели' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Сравнить' }) as HTMLButtonElement).disabled).toBe(false));
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('composer input rules', () => {
  it('does not submit during IME composition or Shift+Enter', () => {
    const submit = vi.fn();
    render(<Composer draft="Вопрос" busy={false} disabled={false} onChange={vi.fn()} onSubmit={submit} />);
    const textarea = screen.getByLabelText('Ваш вопрос');
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229, isComposing: true });
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('enforces the UTF-8 limit without clearing the text', () => {
    const submit = vi.fn();
    const change = vi.fn();
    render(<Composer draft={'я'.repeat(8193)} busy={false} disabled={false} onChange={change} onSubmit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Сравнить' }));
    expect(screen.getByText('Вопрос превышает 16 КиБ. Сократите текст.')).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });
});
