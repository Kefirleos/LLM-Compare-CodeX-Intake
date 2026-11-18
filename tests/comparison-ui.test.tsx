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
  it('shows independent timing leaders only after run completion, with unavailable usage and cost', async () => {
    let finish!: (response: ComparisonResponse) => void;
    send.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Q');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    const [input, , update] = send.mock.calls[0]!;
    const response = responseFor(input);
    response.results.forEach((result, index) => {
      result.totalMs = index === 0 ? 2000 : 1000;
      result.metrics = { firstEventMs: 100, firstAnswerMs: index === 0 ? 200 : 300, inputTokens: null, outputTokens: null, cost: null };
    });
    act(() => response.results.forEach((result, i) => update!({ v: 1, runId: input.runId, turnId: input.turnId, seq: i + 1, type: 'model_result', result })));
    expect(screen.queryByRole('list', { name: 'Сравнение метрик' })).toBeNull();
    await act(async () => finish(response));
    const first = screen.getByRole('region', { name: 'Ответ Демо · Краткий ответ' });
    const second = screen.getByRole('region', { name: 'Ответ Демо · Подробный ответ' });
    const metrics = first.querySelector('details');
    expect(metrics?.open).toBe(false);
    await user.click(within(first).getByText('Метрики'));
    expect(metrics?.open).toBe(true);
    expect(within(first).getByText('Минимальное время до ответа')).toBeTruthy();
    expect(within(first).queryByText('Минимальное общее время')).toBeNull();
    expect(within(second).getByText('Минимальное общее время')).toBeTruthy();
    expect(within(second).queryByText('Минимальное время до ответа')).toBeNull();
    expect(within(first).getAllByText('нет данных')).toHaveLength(3);
    expect(within(first).getByText('Полный ответ')).toBeTruthy();
  });

  it('continues separate histories and retries the latest question with its original snapshot', async () => {
    send.mockImplementation(async (input) => responseFor(input, input.prompt === 'Q2' && 'targets' in input));
    await mount();
    const user = userEvent.setup();
    const textarea = screen.getByLabelText('Ваш вопрос');
    await user.type(textarea, 'Q1');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await screen.findByText('Ответ mock-clear');
    await user.type(textarea, 'Q2');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await screen.findByText('Тестовая ошибка');
    const second = send.mock.calls[1]![0] as ComparisonRequest;
    expect(second.targets.map((target) => target.history)).toEqual([
      [{ user: 'Q1', assistant: 'Ответ mock-clear' }], [{ user: 'Q1', assistant: 'Ответ mock-detailed' }],
    ]);
    await user.type(textarea, 'Q3');
    await user.click(screen.getByRole('button', { name: 'Повторить ответ' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Повторить ответ' })).toBeNull());
    const retry = send.mock.calls[2]![0] as RetryRequest;
    expect(retry.prompt).toBe('Q2');
    expect(retry.target.history).toEqual(second.targets[1]!.history);
    expect(retry.target.attemptId).not.toBe(second.targets[1]!.attemptId);
    expect(retry.serializerVersion).toBe(1);
    expect((textarea as HTMLTextAreaElement).value).toBe('Q3');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    const third = send.mock.calls[3]![0] as ComparisonRequest;
    expect(third.targets.map((target) => target.history)).toEqual([
      [{ user: 'Q1', assistant: 'Ответ mock-clear' }, { user: 'Q2', assistant: 'Ответ mock-clear' }],
      [{ user: 'Q1', assistant: 'Ответ mock-detailed' }, { user: 'Q2', assistant: 'Ответ mock-detailed' }],
    ]);
    expect(screen.getByText('Q1')).toBeTruthy();
    expect(screen.getByText('Q2')).toBeTruthy();
  });

  it('skips failed pairs, starts late models with empty history and disables old retries', async () => {
    send.mockImplementation(async (input) => responseFor(input, input.prompt === 'Q1'));
    await mount();
    const user = userEvent.setup();
    const textarea = screen.getByLabelText('Ваш вопрос');
    await user.type(textarea, 'Q1');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await screen.findByText('Тестовая ошибка');
    await user.click(screen.getByRole('button', { name: 'Добавить модель' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Медленный ответ/ }));
    await user.type(textarea, 'Q2');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await screen.findByText('Ответ mock-slow');
    const second = send.mock.calls[1]![0] as ComparisonRequest;
    expect(second.targets.map((target) => target.history)).toEqual([[{ user: 'Q1', assistant: 'Ответ mock-clear' }], [], []]);
    expect(screen.queryByRole('button', { name: 'Повторить ответ' })).toBeNull();
    expect(screen.getByText('Повтор доступен только для последнего вопроса.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Удалить Демо · Медленный ответ' }));
    await user.click(screen.getByRole('button', { name: 'Добавить модель' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Медленный ответ/ }));
    await user.type(textarea, 'Q3');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const third = send.mock.calls[2]![0] as ComparisonRequest;
    expect(third.targets[2]!.columnId).not.toBe(second.targets[2]!.columnId);
    expect(third.targets[2]!.history).toEqual([]);
  });

  it('shows Thinking only for real events, collapses on answer and retains it after Stop', async () => {
    send.mockImplementation(() => new Promise(() => {}));
    await mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Вопрос');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    expect(screen.queryByRole('button', { name: /Thinking/ })).toBeNull();
    const [body, , update] = send.mock.calls[0]!;
    const input = body as ComparisonRequest;
    const target = input.targets[0]!;
    const base = { v: 1 as const, runId: body.runId, turnId: body.turnId, columnId: target.columnId, modelId: target.modelId, attemptId: target.attemptId };
    act(() => {
      update!({ ...base, seq: 1, type: 'reasoning_started' });
      update!({ ...base, seq: 2, type: 'reasoning_delta', text: 'Тестовое рассуждение' });
    });
    expect(screen.getByRole('button', { name: /Thinking/ }).getAttribute('aria-expanded')).toBe('true');
    act(() => update!({ ...base, seq: 3, type: 'answer_delta', text: 'Ответ модели' }));
    expect(screen.getByRole('button', { name: /Thinking/ }).getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('button', { name: /Thinking/ }));
    expect(screen.getByRole('button', { name: /Thinking/ }).getAttribute('aria-expanded')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Остановить' }));
    expect(screen.getByText('Тестовое рассуждение')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Thinking · прервано/ })).toBeTruthy();
    expect(screen.getByText('Ответ модели')).toBeTruthy();
  });

  it('keeps completed and partial answers on Stop and ignores late events from an older run', async () => {
    send.mockImplementation(() => new Promise(() => {}));
    await mount();
    const user = userEvent.setup();
    const textarea = screen.getByLabelText('Ваш вопрос');
    await user.type(textarea, 'Вопрос');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    const [body, signal, update] = send.mock.calls[0]!;
    const response = responseFor(body);
    const common = { v: 1 as const, runId: body.runId, turnId: body.turnId };
    const first = response.results[0]!;
    const second = response.results[1]!;
    await user.type(textarea, 'Следующий вопрос');
    const stop = screen.getByRole('button', { name: 'Остановить' });
    act(() => {
      update!({ ...common, seq: 1, type: 'model_result', result: first });
      update!({ ...common, seq: 2, type: 'answer_delta', columnId: second.columnId, attemptId: second.attemptId, modelId: second.modelId, text: 'Частичный ответ' });
      stop.click();
    });
    expect(signal.aborted).toBe(true);
    expect(screen.getByText('Ответ mock-clear')).toBeTruthy();
    expect(screen.getByText('Частичный ответ')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    act(() => update!({ ...common, seq: 3, type: 'model_result', result: second }));
    expect(screen.queryByText('Ответ mock-detailed')).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('preserves a finished column and partial text after a broken stream', async () => {
    let fail!: (reason: Error) => void;
    send.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ваш вопрос'), 'Вопрос');
    await user.click(screen.getByRole('button', { name: 'Сравнить' }));
    const [body, , update] = send.mock.calls[0]!;
    const response = responseFor(body);
    const common = { v: 1 as const, runId: body.runId, turnId: body.turnId };
    const target = response.results[1]!;
    await act(async () => {
      update!({ ...common, seq: 1, type: 'model_result', result: response.results[0]! });
      update!({ ...common, seq: 2, type: 'answer_delta', columnId: target.columnId, attemptId: target.attemptId, modelId: target.modelId, text: 'Частичный ответ' });
      fail(new Error('Поток оборван'));
    });
    expect(screen.getByText('Ответ mock-clear')).toBeTruthy();
    expect(screen.getByText('Частичный ответ')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Повторить ответ' })).toHaveLength(1);
  });

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
