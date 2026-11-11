// @vitest-environment jsdom
import { StrictMode } from 'react';
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComparisonRequest, ComparisonResponse, ModelCatalog, RetryRequest } from '@llm-compare/contracts';
import { ConversationWorkspace } from '../apps/web/src/features/storage/ConversationWorkspace';
import { ConversationRepository, StorageError } from '../apps/web/src/features/storage/repository';
import type { ConversationData } from '../apps/web/src/features/storage/schema';
import { sendComparison } from '../apps/web/src/api/comparisons';
import { fetchCatalog } from '../apps/web/src/api/catalog';
import { App } from '../apps/web/src/app/App';

vi.mock('../apps/web/src/api/comparisons', () => ({ sendComparison: vi.fn() }));
vi.mock('../apps/web/src/api/catalog', () => ({ fetchCatalog: vi.fn() }));
const send = vi.mocked(sendComparison);
const repositories: ConversationRepository[] = [];
let factory: IDBFactory;
let repositoryFactory: () => ConversationRepository;
let inspector: ConversationRepository;
const catalog: ModelCatalog = { protocolVersion: 1, catalogVersion: 'test', mode: 'mock', models: ['a', 'b'].map((id) => ({ id, displayName: `Model ${id}`, provider: 'Demo', capabilities: { streaming: 'supported', reasoning: 'unknown' }, pricing: null, metadataSource: 'mock' })) };
beforeEach(() => {
  sessionStorage.clear();
  factory = new IDBFactory();
  repositoryFactory = () => { const repository = new ConversationRepository(factory, 'llm-compare-history'); repositories.push(repository); return repository; };
  inspector = repositoryFactory();
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  send.mockImplementation(async (input) => response(input));
});
afterEach(() => { cleanup(); repositories.splice(0).forEach((repository) => repository.close()); vi.resetAllMocks(); vi.unstubAllGlobals(); });
function response(input: ComparisonRequest | RetryRequest): ComparisonResponse {
  const targets = 'targets' in input ? input.targets : [input.target];
  return { protocolVersion: 1, runId: input.runId, turnId: input.turnId, conversationId: input.conversationId, results: targets.map((target) => ({ columnId: target.columnId, attemptId: target.attemptId, modelId: target.modelId, text: `Answer ${target.modelId}`, status: 'succeeded', totalMs: 42, error: null })) };
}
async function mount() {
  const view = render(<StrictMode><ConversationWorkspace catalog={catalog} repositoryFactory={repositoryFactory} /></StrictMode>);
  await screen.findByLabelText('Ваш вопрос'); return view;
}
async function savedData(): Promise<ConversationData | undefined> {
  const list = await inspector.list(); const id = list.entries[0]?.id;
  return id ? (await inspector.load(id)).record?.data : undefined;
}
async function finishedConversation() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Ваш вопрос'), 'Question'); await user.click(screen.getByRole('button', { name: 'Сравнить' }));
  await screen.findByText('Answer a');
  await waitFor(async () => expect((await savedData())?.turns[0]?.results).toBeDefined());
  return user;
}

it('saves and restores complete answers, selected model metadata and an exact draft without generation', async () => {
  const view = await mount(); await finishedConversation();
  const draft = '  draft 👋\n  new line';
  fireEvent.change(screen.getByLabelText('Ваш вопрос'), { target: { value: draft } });
  await waitFor(async () => expect((await savedData())?.draft).toBe(draft), { timeout: 2000 });
  const before = await savedData(); view.unmount();
  await mount(); await screen.findByText('Answer a');
  expect((screen.getByLabelText('Ваш вопрос') as HTMLTextAreaElement).value).toBe(draft);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await savedData())?.columns).toEqual(before?.columns);
});

it('restores partial response and Thinking as interrupted and permits only an explicit retry', async () => {
  send.mockImplementation(() => new Promise(() => {}));
  const view = await mount(); const user = userEvent.setup();
  await user.type(screen.getByLabelText('Ваш вопрос'), 'Original question'); await user.click(screen.getByRole('button', { name: 'Сравнить' }));
  const [input, , update] = send.mock.calls[0]!; const target = (input as ComparisonRequest).targets[0]!;
  act(() => {
    update!({ v: 1, runId: input.runId, turnId: input.turnId, seq: 1, type: 'answer_delta', columnId: target.columnId, modelId: target.modelId, attemptId: target.attemptId, text: 'Partial answer' });
    update!({ v: 1, runId: input.runId, turnId: input.turnId, seq: 2, type: 'reasoning_delta', columnId: target.columnId, modelId: target.modelId, attemptId: target.attemptId, text: 'Partial thinking' });
  });
  expect((screen.getByLabelText('Сохранённые беседы') as HTMLSelectElement).disabled).toBe(true);
  await waitFor(async () => expect((await savedData())?.turns[0]?.results[target.columnId]?.text).toBe('Partial answer'), { timeout: 2000 });
  view.unmount(); await mount();
  await screen.findByText('Partial answer'); expect(screen.getByRole('button', { name: /Thinking · прервано/ })).toBeTruthy();
  expect(send).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText(/Страница была закрыта/)).toHaveLength(2);
  send.mockImplementation(async (input) => response(input));
  await user.click(screen.getAllByRole('button', { name: 'Повторить ответ' })[0]!); await screen.findByText('Answer a');
  expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1]![0].prompt).toBe('Original question');
});

it('blocks stale autosave, keeps the local draft and offers an explicit copy', async () => {
  await mount(); await finishedConversation();
  const original = (await savedData())!; const loaded = await inspector.load(original.conversationId);
  await inspector.saveSnapshot({ ...original, draft: 'other tab' }, loaded.record!.revision, loaded.meta.generation);
  fireEvent.change(screen.getByLabelText('Ваш вопрос'), { target: { value: 'local unsaved' } });
  await screen.findByText(/Беседа изменена или удалена в другой вкладке/);
  expect((screen.getByLabelText('Ваш вопрос') as HTMLTextAreaElement).value).toBe('local unsaved');
  expect((await inspector.load(original.conversationId)).record?.data.draft).toBe('other tab');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Сохранить как новую беседу' }));
  await waitFor(async () => expect((await inspector.list()).entries).toHaveLength(2));
  const copy = await savedData(); expect(copy?.conversationId).not.toBe(original.conversationId); expect(copy?.draft).toBe('local unsaved');
  expect(send).toHaveBeenCalledTimes(1);
});

it('clears history explicitly and prevents old tabs from restoring it later', async () => {
  await mount(); const user = await finishedConversation(); const before = (await savedData())!;
  const old = await inspector.load(before.conversationId);
  await user.click(screen.getByRole('button', { name: 'Очистить историю' })); await user.click(screen.getByRole('button', { name: 'Подтвердить удаление' }));
  await waitFor(async () => expect((await inspector.list()).entries).toHaveLength(0));
  expect(screen.queryByText('Answer a')).toBeNull();
  await expect(inspector.saveSnapshot(before, old.record!.revision, old.meta.generation)).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('removes one saved conversation after confirmation without restoring it on reload', async () => {
  const view = await mount(); const user = await finishedConversation(); const original = (await savedData())!;
  await user.click(screen.getByRole('button', { name: 'Удалить беседу' }));
  expect((await inspector.list()).entries).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Подтвердить удаление' }));
  await waitFor(async () => expect((await inspector.list()).entries).toHaveLength(0));
  view.unmount(); await mount();
  expect(screen.queryByText('Answer a')).toBeNull(); expect((await inspector.load(original.conversationId)).record).toBeNull();
});

it('restores this tab’s selected conversation rather than a newer write in another conversation', async () => {
  const view = await mount(); await finishedConversation(); const selected = (await savedData())!;
  await inspector.saveSnapshot({ ...selected, conversationId: crypto.randomUUID(), draft: 'another conversation' }, 0, 0);
  view.unmount(); await mount();
  expect((screen.getByLabelText('Ваш вопрос') as HTMLTextAreaElement).value).not.toBe('another conversation');
  expect((screen.getByLabelText('Сохранённые беседы') as HTMLSelectElement).value).toBe(selected.conversationId);
});

it('persists saving-off and leaves previous conversations intact', async () => {
  const view = await mount(); const user = await finishedConversation(); const original = (await savedData())!;
  await user.click(screen.getByRole('checkbox', { name: 'Сохранять на этом устройстве' })); await screen.findByText('Сохранение отключено');
  fireEvent.change(screen.getByLabelText('Ваш вопрос'), { target: { value: 'not saved' } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  expect((await inspector.load(original.conversationId)).record?.data.draft).not.toBe('not saved');
  view.unmount(); await mount(); expect((screen.getByRole('checkbox', { name: 'Сохранять на этом устройстве' }) as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByText('Answer a')).toBeNull(); expect((await inspector.list()).entries).toHaveLength(1);
});

it('flushes the previous conversation before starting a new one and opens it from the list', async () => {
  await mount(); const user = await finishedConversation(); const original = (await savedData())!;
  fireEvent.change(screen.getByLabelText('Ваш вопрос'), { target: { value: 'latest draft' } });
  await user.click(screen.getByRole('button', { name: 'Новое сравнение' }));
  await waitFor(() => expect(screen.queryByText('Answer a')).toBeNull());
  expect((await inspector.load(original.conversationId)).record?.data.draft).toBe('latest draft');
  await waitFor(async () => expect((await inspector.list()).entries).toHaveLength(2), { timeout: 2000 });
  await user.selectOptions(screen.getByLabelText('Сохранённые беседы'), original.conversationId);
  await screen.findByText('Answer a'); expect((screen.getByLabelText('Ваш вопрос') as HTMLTextAreaElement).value).toBe('latest draft');
  expect(send).toHaveBeenCalledTimes(1);
});

it('continues in memory when IndexedDB cannot open', async () => {
  const unavailable = () => { throw new StorageError('UNAVAILABLE'); };
  render(<ConversationWorkspace catalog={catalog} repositoryFactory={unavailable} />);
  await screen.findByLabelText('Ваш вопрос'); expect(screen.getByText(/Локальная история недоступна или заполнена/)).toBeTruthy();
  const user = userEvent.setup(); await user.type(screen.getByLabelText('Ваш вопрос'), 'Q'); await user.click(screen.getByRole('button', { name: 'Сравнить' }));
  await screen.findByText('Answer a'); expect(send).toHaveBeenCalledOnce();
});

it('reads saved answers when the catalog is unavailable, and preserves them after catalog retry', async () => {
  const view = await mount(); await finishedConversation(); view.unmount();
  vi.stubGlobal('indexedDB', factory); vi.mocked(fetchCatalog).mockRejectedValueOnce(new Error('Catalog offline')).mockResolvedValue(catalog);
  render(<App />); await screen.findByText('Answer a'); expect(screen.getByText('Catalog offline')).toBeTruthy();
  expect(send).toHaveBeenCalledTimes(1);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Повторить' }));
  await waitFor(() => expect(screen.queryByText('Catalog offline')).toBeNull());
  expect(screen.getByText('Answer a')).toBeTruthy(); expect(send).toHaveBeenCalledTimes(1);
});
