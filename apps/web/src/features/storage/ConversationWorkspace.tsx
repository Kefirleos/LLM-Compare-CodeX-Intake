import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelCatalog } from '@llm-compare/contracts';
import { Comparison } from '../comparison/Comparison';
import { ConversationRepository, StorageError } from './repository';
import type { HistoryEntry, HistoryNotice, StorageMeta } from './repository';
import { ConversationSaver } from './saver';
import { recoverConversation } from './schema';
import type { ConversationData, SavedConversation } from './schema';

const defaultRepository = () => {
  if (typeof indexedDB === 'undefined') throw new StorageError('UNAVAILABLE');
  return new ConversationRepository(indexedDB, 'llm-compare-history', true);
};
function storageMessage(error: unknown): string {
  if (error instanceof StorageError) {
    if (error.code === 'CONFLICT') return 'Беседа изменена или удалена в другой вкладке. Автосохранение приостановлено: загрузите сохранённую версию или создайте копию.';
    if (error.code === 'UNSUPPORTED') return 'Версия локальной истории не поддерживается. Сохранённые данные не изменены.';
    if (error.code === 'CORRUPT') return 'Не удалось прочитать эту беседу. Остальная история сохранена.';
    if (error.code === 'LIMIT') return 'Достигнут лимит локальной истории. Удалите ненужные беседы или очистите историю.';
    if (error.code === 'DISABLED') return 'Сохранение отключено в другой вкладке. Текущая беседа остаётся в памяти.';
  }
  if (error instanceof Error && error.message === 'CONVERSATION_TOO_LARGE') return 'Беседа превышает лимит сохранения 2 МиБ. Текущая работа остаётся в памяти.';
  return 'Локальная история недоступна или заполнена. Текущая работа продолжается в памяти; автоматический повтор запросов отключён.';
}
const entryFor = (record: SavedConversation): HistoryEntry => ({ id: record.conversationId, title: record.data.turns[0]?.prompt.slice(0, 80) || record.data.draft.slice(0, 80) || 'Новое сравнение', updatedAt: record.updatedAt, revision: record.revision, mode: record.data.mode });
const activeKey = 'llm-compare-active-conversation';
function rememberActive(id?: string) { try { if (id) sessionStorage.setItem(activeKey, id); else sessionStorage.removeItem(activeKey); } catch { /* IndexedDB remains usable if sessionStorage is blocked. */ } }

export function ConversationWorkspace({ catalog, repositoryFactory = defaultRepository }: { catalog: ModelCatalog | null; repositoryFactory?: () => ConversationRepository }) {
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [pane, setPane] = useState<{ key: number; initial?: ConversationData } | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState(false);
  const [problem, setProblem] = useState('');
  const [warning, setWarning] = useState('');
  const [confirm, setConfirm] = useState<'remove' | 'clear' | null>(null);
  const [currentId, setCurrentId] = useState('');
  const [saved, setSaved] = useState(false);
  const runtime = useRef({ repository: null as ConversationRepository | null, saver: null as ConversationSaver | null,
    meta: { schemaVersion: 1, generation: 0, enabled: true } as StorageMeta, data: null as ConversationData | null, busy: false, blocked: false, key: 0, alive: false, usable: false, forceCapture: false });
  const epoch = useRef(0);
  const actionLock = useRef(false);

  const bind = useCallback((id: string, revision: number) => {
    const state = runtime.current;
    state.saver?.dispose(); state.saver = null; state.blocked = false;
    if (!state.repository || !state.usable) return;
    const repository = state.repository;
    const saver = new ConversationSaver(repository, state.meta.generation, revision, (record) => {
      if (!state.alive || state.repository !== repository || state.meta.generation !== record.generation) return;
      if (state.saver === saver && state.data?.conversationId === id) setSaved(!saver.hasPending);
      setEntries((current) => [entryFor(record), ...current.filter((entry) => entry.id !== id)].sort((a, b) => b.updatedAt - a.updatedAt));
    }, (cause) => {
      if (!state.alive || state.saver !== saver) return;
      state.blocked = true; setSaved(false); setProblem(storageMessage(cause));
    });
    state.saver = saver; saver.setEnabled(state.meta.enabled);
  }, []);

  const install = useCallback((data?: ConversationData, revision = 0, forceCapture = false) => {
    const state = runtime.current;
    state.data = data ?? null; state.busy = false; state.forceCapture = forceCapture;
    rememberActive(data?.conversationId);
    bind(data?.conversationId ?? '', revision);
    setCurrentId(data?.conversationId ?? ''); setSaved(revision > 0); setProblem('');
    setPane(data ? { key: ++state.key, initial: data } : { key: ++state.key });
  }, [bind]);

  const snapshot = useCallback((data: ConversationData, running: boolean) => {
    const state = runtime.current;
    if (!state.alive) return;
    const previousData = state.data;
    const unchanged = previousData?.conversationId === data.conversationId && previousData.mode === data.mode && previousData.columns === data.columns
      && previousData.activeColumn === data.activeColumn && previousData.draft === data.draft && previousData.turns.length === data.turns.length
      && previousData.turns.every((turn, index) => turn === data.turns[index]);
    if (unchanged && state.busy === running && !state.forceCapture) return;
    state.forceCapture = false;
    if (state.data?.conversationId !== data.conversationId) {
      const previous = state.saver;
      // Finish the previous conversation before detaching, without reusing its revision.
      state.saver = null;
      if (previous) void previous.flush().finally(() => previous.dispose());
      bind(data.conversationId, 0); setCurrentId(data.conversationId); setSaved(false); if (state.usable) setProblem('');
      rememberActive(data.conversationId);
    }
    state.data = data; state.busy = running; setBusy(running);
    if (data.columns.length < 2 || (!data.turns.length && !data.draft && state.saver?.revision === 0)) return;
    setSaved(false);
    state.saver?.update(data, running);
  }, [bind]);

  useEffect(() => {
    const token = ++epoch.current;
    const state = runtime.current;
    state.alive = true; state.usable = false;
    let repository: ConversationRepository;
    let unsubscribe = () => {};
    try { repository = repositoryFactory(); state.repository = repository; }
    catch (cause) { install(); setProblem(storageMessage(cause)); setReady(true); return () => { state.alive = false; }; }
    const valid = () => state.alive && epoch.current === token;
    void repository.list().then(async (list) => {
      if (!valid()) return;
      state.meta = list.meta; state.usable = true; setEnabled(list.meta.enabled); setEntries(list.entries); setAvailable(true);
      if (list.invalidIds.length) setWarning('Часть записей повреждена или имеет неподдерживаемую версию. Они не удалены; остальные беседы доступны.');
      let preferred: string | null = null;
      try { preferred = sessionStorage.getItem(activeKey); } catch { /* Fall back to the most recently saved conversation. */ }
      const initialId = preferred ? list.entries.find((entry) => entry.id === preferred)?.id : list.entries[0]?.id;
      if (list.meta.enabled && initialId) {
        const loaded = await repository.load(initialId);
        if (!valid()) return;
        state.meta = loaded.meta;
        if (loaded.record) { const restored = recoverConversation(loaded.record.data); install(restored, loaded.record.revision, restored !== loaded.record.data); } else install();
      } else install();
      if (valid()) setReady(true);
    }).catch((cause: unknown) => { if (valid()) { state.usable = false; install(); setAvailable(false); setProblem(storageMessage(cause)); setReady(true); } });
    unsubscribe = repository.subscribe((notice: HistoryNotice) => {
      if (!valid()) return;
      const data = state.data;
      if (notice.generation !== state.meta.generation || ((notice.type === 'save' || notice.type === 'remove') && notice.id === data?.conversationId
        && (notice.type === 'remove' || (notice.revision ?? 0) > (state.saver?.revision ?? 0)))) {
        state.blocked = true; state.saver?.pause(); setProblem(storageMessage(new StorageError('CONFLICT'))); setSaved(false);
      }
      void repository.list().then((list) => {
        if (!valid()) return;
        setEntries(list.entries);
        if (notice.type === 'preferences' && state.meta.generation === list.meta.generation) {
          state.meta = list.meta; setEnabled(list.meta.enabled); state.saver?.setEnabled(list.meta.enabled);
        }
      }).catch(() => { if (valid()) setWarning('Не удалось обновить список локальных бесед.'); });
    });
    return () => { if (epoch.current === token) state.alive = false; state.saver?.dispose(); unsubscribe(); repository.close(); };
  }, [repositoryFactory, install]);

  async function open(id: string, explicit = false) {
    const state = runtime.current;
    if (!state.repository || state.busy || actionLock.current) return;
    if (state.blocked && !explicit) { setProblem('Сначала создайте копию текущей беседы или явно загрузите сохранённую версию.'); return; }
    actionLock.current = true; setAction(true);
    try {
      await state.saver?.flush();
      if (state.blocked && !explicit) return;
      const loaded = await state.repository.load(id);
      if (!loaded.record) throw new StorageError('CONFLICT');
      state.meta = loaded.meta; setEnabled(loaded.meta.enabled);
      const restored = recoverConversation(loaded.record.data);
      install(restored, loaded.record.revision, restored !== loaded.record.data);
    } catch (cause) { setProblem(storageMessage(cause)); }
    finally { actionLock.current = false; setAction(false); }
  }

  async function copy() {
    const state = runtime.current;
    if (!state.repository || !state.data || state.busy || actionLock.current) return;
    actionLock.current = true; setAction(true);
    try {
      const list = await state.repository.list(); state.meta = list.meta; setEnabled(list.meta.enabled); setEntries(list.entries);
      const data = { ...state.data, conversationId: crypto.randomUUID() };
      install(data);
      state.saver?.update(data, false); await state.saver?.flush();
    } catch (cause) { setProblem(storageMessage(cause)); }
    finally { actionLock.current = false; setAction(false); }
  }

  async function toggle(value: boolean) {
    const state = runtime.current;
    if (!state.repository || actionLock.current) return;
    if (state.blocked) { setProblem(storageMessage(new StorageError('CONFLICT'))); return; }
    actionLock.current = true; setAction(true); state.saver?.setEnabled(false); setEnabled(value);
    try {
      await state.repository.setEnabled(value, state.meta.generation);
      state.meta = { ...state.meta, enabled: value };
      if (value && state.data) { const revision = state.saver?.revision ?? 0; bind(state.data.conversationId, revision); state.saver?.update(state.data, state.busy); }
      else state.saver?.setEnabled(false);
      setProblem('');
    } catch (cause) { setEnabled(state.meta.enabled); setProblem(storageMessage(cause)); }
    finally { actionLock.current = false; setAction(false); }
  }

  async function removeConfirmed() {
    const state = runtime.current;
    if (!state.repository || state.busy || actionLock.current || !confirm) return;
    actionLock.current = true; setAction(true);
    try {
      if (confirm === 'clear') {
        state.saver?.dispose(); state.saver = null;
        state.meta = await state.repository.clear(state.meta.generation); setEntries([]); install();
      } else {
        await state.saver?.flush();
        if (state.blocked || !state.data || !state.saver) throw new StorageError('CONFLICT');
        const conversationId = state.data.conversationId;
        await state.repository.remove(conversationId, state.saver.revision, state.meta.generation);
        setEntries((current) => current.filter((entry) => entry.id !== conversationId));
        install();
      }
      setConfirm(null);
    } catch (cause) { setProblem(storageMessage(cause)); }
    finally { actionLock.current = false; setAction(false); }
  }

  const prepareNew = useCallback(async () => {
    const state = runtime.current;
    if (!state.usable || !state.meta.enabled || state.blocked) return true;
    if (state.busy || actionLock.current) return false;
    actionLock.current = true; setAction(true);
    try { await state.saver?.flush(); return !state.blocked; }
    finally { actionLock.current = false; setAction(false); }
  }, []);

  const fallback = useMemo<ModelCatalog>(() => ({ protocolVersion: 1, catalogVersion: 'unavailable', mode: pane?.initial?.mode ?? 'mock', models: [] }), [pane]);
  return <>
    <details className="history-panel">
    <summary>История бесед</summary>
    <div className="history-toolbar" aria-label="Локальная история">
      <label><input type="checkbox" checked={enabled} disabled={!available || action || runtime.current.blocked} onChange={(event) => { void toggle(event.target.checked); }} /> Сохранять на этом устройстве</label>
      <select aria-label="Сохранённые беседы" value={entries.some((entry) => entry.id === currentId) ? currentId : ''} disabled={!ready || busy || action} onChange={(event) => { if (event.target.value) void open(event.target.value); }}>
        <option value="">Текущая беседа</option>{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.mode === 'mock' ? 'Демо' : 'Live'} · {entry.title}</option>)}
      </select>
      <button disabled={!available || busy || action || !entries.some((entry) => entry.id === currentId)} onClick={() => setConfirm('remove')}>Удалить беседу</button>
      <button disabled={!available || busy || action || (!entries.length && !warning)} onClick={() => setConfirm('clear')}>Очистить историю</button>
      <span role="status">{!ready ? 'Загрузка локальной истории…' : !enabled ? 'Сохранение отключено' : runtime.current.blocked ? 'Сохранение приостановлено' : saved ? 'Сохранено на устройстве' : available ? 'Автосохранение включено' : 'Работа в памяти'}</span>
    </div>
    </details>
    {warning && <p className="storage-notice" role="status">{warning}</p>}
    {problem && <div className="storage-notice" role="alert"><p>{problem}</p>{available && <div>
      <button disabled={busy || action || !currentId} onClick={() => { void open(currentId, true); }}>Загрузить сохранённую версию</button>
      <button disabled={busy || action} onClick={() => { void copy(); }}>Сохранить как новую беседу</button>
    </div>}</div>}
    {confirm && <div className="storage-notice" role="alert"><p>{confirm === 'clear' ? 'Удалить всю локальную историю?' : 'Удалить текущую сохранённую беседу?'}</p>
      <button disabled={busy || action} onClick={() => { void removeConfirmed(); }}>Подтвердить удаление</button><button disabled={action} onClick={() => setConfirm(null)}>Отмена</button>
    </div>}
    {ready && pane && (catalog || pane.initial) && <Comparison key={pane.key} catalog={catalog ?? fallback} {...(pane.initial ? { initialConversation: pane.initial } : {})} onSnapshot={snapshot} beforeReset={prepareNew} workspaceLocked={action} />}
  </>;
}
