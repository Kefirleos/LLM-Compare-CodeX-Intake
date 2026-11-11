import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationRepository, StorageError } from '../apps/web/src/features/storage/repository';
import { ConversationSaver } from '../apps/web/src/features/storage/saver';
import { recoverConversation, validateData } from '../apps/web/src/features/storage/schema';
import type { ConversationData, SavedConversation } from '../apps/web/src/features/storage/schema';

const repositories: ConversationRepository[] = [];
afterEach(() => { repositories.splice(0).forEach((repository) => repository.close()); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function repository(factory = new IDBFactory()) { const instance = new ConversationRepository(factory, 'test-history'); repositories.push(instance); return instance; }
export function conversation(): ConversationData {
  const columns = ['a', 'b'].map((id) => ({ columnId: crypto.randomUUID(), model: { id, displayName: id, provider: 'Demo', capabilities: { streaming: 'supported' as const, reasoning: 'unknown' as const }, pricing: null, metadataSource: 'mock' as const } }));
  const targets = columns.map((column) => ({ columnId: column.columnId, modelId: column.model.id, attemptId: crypto.randomUUID(), history: [] }));
  return { conversationId: crypto.randomUUID(), mode: 'mock', columns, activeColumn: columns[0]!.columnId, draft: '  черновик 👋\n', turns: [{
    turnId: crypto.randomUUID(), prompt: '  Вопрос\n👋', serializerVersion: 1, targets, attempts: {}, results: Object.fromEntries(targets.map((target) => [target.columnId, {
      columnId: target.columnId, modelId: target.modelId, attemptId: target.attemptId, text: '# Ответ\n\n  👋', status: 'succeeded', error: null, totalMs: 42,
    }])),
  }] };
}
async function rawPut(factory: IDBFactory, store: string, value: unknown, key?: string) {
  const db = await new Promise<IDBDatabase>((resolve) => { const open = factory.open('test-history', 1); open.onsuccess = () => resolve(open.result); });
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); }
  finally { db.close(); }
}

it('round-trips exact conversations, columns, metrics and draft across repository instances', async () => {
  const factory = new IDBFactory(); const first = repository(factory); const data = conversation();
  const saved = await first.saveSnapshot(data, 0, 0);
  first.close();
  const second = repository(factory);
  expect((await second.load(data.conversationId)).record).toEqual(saved);
  expect((await second.list()).entries).toMatchObject([{ id: data.conversationId, title: data.turns[0]!.prompt }]);
});

it('restores pending attempts as interrupted without invented timing or automatic generation', async () => {
  const data = conversation(); const target = data.turns[0]!.targets[0]!;
  data.turns[0]!.results[target.columnId] = { status: 'pending', attemptId: target.attemptId, text: 'часть', reasoning: 'мысль', reasoningActive: true };
  const db = repository(); await db.saveSnapshot(data, 0, 0);
  const loaded = recoverConversation((await db.load(data.conversationId)).record!.data);
  expect(loaded.turns[0]!.results[target.columnId]).toMatchObject({ status: 'interrupted', code: 'NETWORK_INTERRUPTED', text: 'часть', reasoning: 'мысль' });
  expect(loaded.turns[0]!.results[target.columnId]).not.toHaveProperty('totalMs');
  expect(loaded.turns[0]!.results[target.columnId]).not.toHaveProperty('reasoningActive');
  expect(loaded.turns[0]!.results[data.turns[0]!.targets[1]!.columnId]).toEqual(data.turns[0]!.results[data.turns[0]!.targets[1]!.columnId]);
});

it('atomically rejects concurrent writes from the same revision without BroadcastChannel', async () => {
  const factory = new IDBFactory(); const a = repository(factory); const b = repository(factory); const data = conversation();
  await a.saveSnapshot(data, 0, 0);
  const outcomes = await Promise.allSettled([a.saveSnapshot({ ...data, draft: 'A' }, 1, 0), b.saveSnapshot({ ...data, draft: 'B' }, 1, 0)]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } });
  expect((await a.load(data.conversationId)).record?.revision).toBe(2);
});

it('uses atomic checks even when cross-tab notifications are delayed, and broadcasts no conversation content', async () => {
  const channels: DelayedChannel[] = []; const deliveries: (() => void)[] = []; const notices: unknown[] = [];
  class DelayedChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(readonly name: string) { channels.push(this); }
    postMessage(data: unknown) { notices.push(data); for (const other of channels) if (other !== this && other.name === this.name) deliveries.push(() => other.onmessage?.({ data })); }
    close() { this.onmessage = null; }
  }
  vi.stubGlobal('BroadcastChannel', DelayedChannel);
  const factory = new IDBFactory(); const a = new ConversationRepository(factory, 'test-history', true); const b = new ConversationRepository(factory, 'test-history', true); repositories.push(a, b);
  const notified = vi.fn(); b.subscribe(notified); const data = conversation();
  await a.saveSnapshot(data, 0, 0); await a.saveSnapshot({ ...data, draft: 'newer' }, 1, 0);
  expect(notified).not.toHaveBeenCalled(); await expect(b.saveSnapshot(data, 1, 0)).rejects.toMatchObject({ code: 'CONFLICT' });
  deliveries.splice(0).forEach((deliver) => deliver()); expect(notified).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(notices)).not.toContain(data.draft); expect(JSON.stringify(notices)).not.toContain('data');
  await a.clear(0); await expect(b.saveSnapshot(data, 2, 0)).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('never recreates a deleted conversation, even with an invented latest revision', async () => {
  const db = repository(); const data = conversation(); await db.saveSnapshot(data, 0, 0); await db.remove(data.conversationId, 1, 0);
  for (const revision of [0, 1, 2]) await expect(db.saveSnapshot(data, revision, 0)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await db.load(data.conversationId)).record).toBeNull();
  expect((await db.list()).entries).toHaveLength(0);
});

it.each(['save before clear', 'clear before save'] as const)('prevents stale tabs from returning cleared data: %s', async (order) => {
  const factory = new IDBFactory(); const a = repository(factory); const b = repository(factory); const data = conversation(); await a.saveSnapshot(data, 0, 0);
  if (order === 'save before clear') await Promise.all([a.saveSnapshot({ ...data, draft: 'late' }, 1, 0), b.clear(0)]);
  else { await b.clear(0); await expect(a.saveSnapshot(data, 1, 0)).rejects.toMatchObject({ code: 'CONFLICT' }); }
  await expect(a.saveSnapshot(conversation(), 0, 0)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await a.list()).entries).toHaveLength(0);
  expect((await a.list()).meta.generation).toBe(1);
  await a.saveSnapshot(conversation(), 0, 1);
  expect((await a.list()).entries).toHaveLength(1);
});

it.each(['future', 'corrupt'] as const)('preserves an unreadable record and other conversations: %s', async (kind) => {
  const factory = new IDBFactory(); const db = repository(factory); const a = conversation(); const b = conversation();
  const original = await db.saveSnapshot(a, 0, 0); await db.saveSnapshot(b, 0, 0);
  await rawPut(factory, 'conversations', kind === 'future' ? { ...original, schemaVersion: 2 } : { ...original, data: { ...a, turns: 'broken' } });
  const list = await db.list(); expect(list.entries.map((entry) => entry.id)).toEqual([b.conversationId]); expect(list.invalidIds).toHaveLength(1);
  await expect(db.load(a.conversationId)).rejects.toMatchObject({ code: kind === 'future' ? 'UNSUPPORTED' : 'CORRUPT' });
  await expect(db.saveSnapshot(a, 1, 0)).rejects.toMatchObject({ code: kind === 'future' ? 'UNSUPPORTED' : 'CORRUPT' });
  expect((await db.load(b.conversationId)).record?.data).toEqual(b);
});

it('does not read or overwrite unknown metadata versions', async () => {
  const factory = new IDBFactory(); const db = repository(factory); await db.list();
  await rawPut(factory, 'meta', { schemaVersion: 2, generation: 0, enabled: true }, 'state');
  await expect(db.list()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  await expect(db.saveSnapshot(conversation(), 0, 0)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
});

it('refuses a database created by a newer application without downgrading it', async () => {
  const factory = new IDBFactory();
  await new Promise<void>((resolve) => { const opened = factory.open('test-history', 2); opened.onsuccess = () => { opened.result.close(); resolve(); }; });
  await expect(repository(factory).list()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
});

it('keeps previous data on quota errors and rejects oversized snapshots', async () => {
  const db = repository(); const data = conversation(); await db.saveSnapshot(data, 0, 0);
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await expect(db.saveSnapshot({ ...data, draft: 'new draft' }, 1, 0)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  put.mockRestore();
  expect((await db.load(data.conversationId)).record?.data).toEqual(data);
  const large = structuredClone(data); Object.assign(large.turns[0]!.results[large.columns[0]!.columnId]!, { text: 'x'.repeat(2 * 1024 * 1024) });
  await expect(db.saveSnapshot(large, 1, 0)).rejects.toThrow('CONVERSATION_TOO_LARGE');
  expect((await db.load(data.conversationId)).record?.revision).toBe(1);
});

it('enforces the history limit without evicting old data', async () => {
  const db = repository();
  for (let i = 0; i < 50; i++) await db.saveSnapshot(conversation(), 0, 0);
  await expect(db.saveSnapshot(conversation(), 0, 0)).rejects.toMatchObject({ code: 'LIMIT' });
  expect((await db.list()).entries).toHaveLength(50);
});

it('persists the saving preference and rejects old writers while saving is disabled', async () => {
  const db = repository(); await db.setEnabled(false, 0);
  expect((await db.list()).meta.enabled).toBe(false);
  await expect(db.saveSnapshot(conversation(), 0, 0)).rejects.toMatchObject({ code: 'DISABLED' });
  await db.setEnabled(true, 0); await db.saveSnapshot(conversation(), 0, 0);
});

it('rejects server configuration, secrets and runtime objects outside the saved DTO', () => {
  expect(() => validateData({ ...conversation(), serverConfig: { apiKey: 'fixture-secret' }, controller: new AbortController() })).toThrow();
});

const record = (data: ConversationData, revision: number, generation: number): SavedConversation => ({ data, conversationId: data.conversationId, revision, generation, schemaVersion: 1, status: 'saved', updatedAt: 1 });
it('coalesces streams without starvation and flushes terminal data immediately', async () => {
  vi.useFakeTimers();
  const saveSnapshot = vi.fn(async (data: ConversationData, revision: number, generation: number) => record(data, revision + 1, generation));
  const saver = new ConversationSaver({ saveSnapshot }, 0, 0, vi.fn(), vi.fn()); const data = conversation();
  for (let i = 0; i < 10; i++) { saver.update({ ...data, draft: String(i) }, true); await vi.advanceTimersByTimeAsync(100); }
  expect(saveSnapshot.mock.calls.length).toBeLessThanOrEqual(2); expect(saveSnapshot.mock.calls.length).toBeGreaterThan(0);
  saver.update({ ...data, draft: 'final' }, false); await saver.flush();
  expect(saveSnapshot.mock.calls.at(-1)![0].draft).toBe('final'); saver.dispose(); expect(vi.getTimerCount()).toBe(0);
});

it('serializes an in-flight write and saves the latest snapshot using its new revision', async () => {
  vi.useFakeTimers(); let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const saveSnapshot = vi.fn(async (data: ConversationData, revision: number, generation: number) => { if (!revision) await gate; return record(data, revision + 1, generation); });
  const pendingAtCommit: boolean[] = [];
  const saver = new ConversationSaver({ saveSnapshot }, 0, 0, () => { pendingAtCommit.push(saver.hasPending); }, vi.fn()); const data = conversation();
  saver.update({ ...data, draft: 'old' }, true); await vi.advanceTimersByTimeAsync(500);
  saver.update({ ...data, draft: 'newest' }, false); const flushed = saver.flush();
  expect(saveSnapshot).toHaveBeenCalledTimes(1); finish(); await flushed;
  expect(saveSnapshot.mock.calls.map(([data, revision]) => [data.draft, revision])).toEqual([['old', 0], ['newest', 1]]);
  expect(pendingAtCommit).toEqual([true, false]);
  saver.dispose();
});

it('discards pending saves on disposal and blocks automatic retries after a conflict', async () => {
  vi.useFakeTimers(); const failed = vi.fn();
  const saveSnapshot = vi.fn(async () => { throw new StorageError('CONFLICT'); });
  const a = new ConversationSaver({ saveSnapshot }, 0, 0, vi.fn(), failed); a.update(conversation(), true); a.dispose(); await vi.runAllTimersAsync(); expect(saveSnapshot).not.toHaveBeenCalled();
  const b = new ConversationSaver({ saveSnapshot }, 0, 0, vi.fn(), failed); b.update(conversation(), true); await vi.advanceTimersByTimeAsync(500);
  b.update(conversation(), false); await b.flush(); expect(saveSnapshot).toHaveBeenCalledTimes(1); expect(failed).toHaveBeenCalledOnce(); b.dispose();
});
