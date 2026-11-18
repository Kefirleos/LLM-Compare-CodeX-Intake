import { Fragment, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { comparisonRequestSchema, retryRequestSchema } from '@llm-compare/contracts';
import type { ComparisonRequest, ModelCatalog, ModelDescriptor, RetryRequest } from '@llm-compare/contracts';
import { sendComparison } from '../../api/comparisons';
import { Composer } from '../composer/Composer';
import { ModelPicker } from '../models/ModelPicker';
import { Answer } from './Answer';
import { buildHistory, skippedTurns } from './history';
import type { DisplayResult, Turn } from './history';
import { comparisonLeaders } from './metrics';
import { fetchCatalog } from '../../api/catalog';
import { WorkspaceHeader } from '../../app/WorkspaceHeader';
import type { ConversationData } from '../storage/schema';

type Column = { columnId: string; model: ModelDescriptor };

const createColumn = (model: ModelDescriptor): Column => ({ columnId: crypto.randomUUID(), model });
const modelName = (model: ModelDescriptor) => model.metadataSource === 'mock' ? model.displayName.replace(/^Демо · /u, '') : model.displayName;
const statusText = (result?: DisplayResult) => {
  if (!result) return 'Готова к вопросу';
  return { pending: 'Получение ответа…', succeeded: 'Готово', failed: 'Ошибка', timed_out: 'Таймаут', cancelled: 'Прервано', interrupted: 'Прервано', network_error: 'Соединение прервано', stopped: 'Остановлено' }[result.status];
};

export function Comparison({ catalog: initialCatalog, initialConversation, onSnapshot, beforeReset, workspaceLocked = false, history, notices }: {
  catalog: ModelCatalog; initialConversation?: ConversationData; onSnapshot?: (data: ConversationData, busy: boolean) => void;
  beforeReset?: () => Promise<boolean>; workspaceLocked?: boolean; history?: ReactNode; notices?: ReactNode;
}) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [conversationId, setConversationId] = useState(() => initialConversation?.conversationId ?? crypto.randomUUID());
  const [conversationMode, setConversationMode] = useState(() => initialConversation?.mode ?? catalog.mode);
  const [columns, setColumns] = useState<Column[]>(() => initialConversation?.columns ?? catalog.models.slice(0, 2).map(createColumn));
  const [activeColumn, setActiveColumn] = useState(initialConversation?.activeColumn ?? '');
  const [draft, setDraft] = useState(initialConversation?.draft ?? '');
  const [turn, setTurn] = useState<Turn | null>(() => initialConversation?.turns.at(-1) ?? null);
  const [pastTurns, setPastTurns] = useState<Turn[]>(() => initialConversation?.turns.slice(0, -1) ?? []);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState('');
  const [recoverPrompt, setRecoverPrompt] = useState('');
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 1000px)').matches);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const catalogController = useRef<AbortController | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const selectedId = columns.some((column) => column.columnId === activeColumn) ? activeColumn : columns[0]?.columnId;
  const availableIds = new Set(catalog.models.map((model) => model.id));
  const hasUnavailable = conversationMode !== catalog.mode || columns.length < 2 || columns.some((column) => !availableIds.has(column.model.id));
  const catalogBlocked = catalogRefreshing || Boolean(catalogError) || workspaceLocked;

  useEffect(() => () => { controller.current?.abort(); catalogController.current?.abort(); }, []);
  useEffect(() => { setCatalog(initialCatalog); }, [initialCatalog]);
  useEffect(() => {
    onSnapshot?.({ conversationId, mode: conversationMode, columns, activeColumn, draft, turns: [...pastTurns, ...(turn ? [turn] : [])] }, busy);
  }, [conversationId, conversationMode, columns, activeColumn, draft, pastTurns, turn, busy, onSnapshot]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1000px)');
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);

  function closePicker() {
    setPicker(false);
  }

  async function refreshCatalog() {
    if (lock.current || catalogController.current || workspaceLocked) return;
    const transport = new AbortController();
    catalogController.current = transport;
    setCatalogRefreshing(true);
    try {
      const updated = await fetchCatalog(transport.signal, true);
      if (transport.signal.aborted) return;
      setCatalog(updated);
      setCatalogError('');
    } catch {
      if (!transport.signal.aborted) setCatalogError('Не удалось обновить каталог. Ответы сохранены. Повторите обновление перед новым запросом.');
    } finally {
      if (catalogController.current === transport) catalogController.current = null;
      if (!transport.signal.aborted) setCatalogRefreshing(false);
    }
  }

  async function execute(input: ComparisonRequest | RetryRequest) {
    if (lock.current || catalogController.current || catalogError || workspaceLocked || conversationMode !== catalog.mode || ('targets' in input && hasUnavailable)) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setRecoverPrompt('');
    const targets = 'targets' in input ? input.targets : [input.target];
    const pending = Object.fromEntries(targets.map((target) => [target.columnId, { status: 'pending' as const, attemptId: target.attemptId }]));
    if ('targets' in input) {
      if (turn) setPastTurns((current) => [...current, turn]);
      setTurn({ turnId: input.turnId, prompt: input.prompt, results: pending, targets: structuredClone(input.targets), serializerVersion: 1, attempts: {} });
      setDraft('');
    } else setTurn((current) => current ? { ...current, results: { ...current.results, ...pending }, attempts: {
      ...current.attempts, [input.target.columnId]: [...(current.attempts[input.target.columnId] ?? []), current.results[input.target.columnId]!],
    } } : current);
    const transport = new AbortController();
    controller.current = transport;
    const acceptsUpdates = () => controller.current === transport && !transport.signal.aborted;
    try {
      const response = await sendComparison(input, transport.signal, (event) => {
        if (!acceptsUpdates()) return;
        setTurn((current) => {
          // Stop can run before React applies this update. Keep events already accepted from the transport.
          if (current?.turnId !== input.turnId) return current;
          if (event.type === 'model_result') {
            const previous = current.results[event.result.columnId];
            if (previous?.status !== 'pending' || previous.attemptId !== event.result.attemptId) return current;
            return { ...current, results: { ...current.results, [event.result.columnId]: event.result } };
          }
          if (event.type !== 'answer_delta' && event.type !== 'reasoning_delta' && event.type !== 'reasoning_started' && event.type !== 'reasoning_ended') return current;
          const previous = current.results[event.columnId];
          if (previous?.status !== 'pending' || previous.attemptId !== event.attemptId) return current;
          const updated = event.type === 'answer_delta' ? { ...previous, text: (previous.text ?? '') + event.text, reasoningActive: false }
            : event.type === 'reasoning_delta' ? { ...previous, reasoning: (previous.reasoning ?? '') + event.text, reasoningActive: true }
              : { ...previous, reasoningActive: event.type === 'reasoning_started' };
          return { ...current, results: { ...current.results, [event.columnId]: updated } };
        });
      });
      if (!acceptsUpdates()) return;
      const results = Object.fromEntries(response.results.map((result) => [result.columnId, result]));
      setTurn((current) => current?.turnId === input.turnId ? { ...current, results: { ...current.results, ...results } } : current);
    } catch (cause) {
      if (!acceptsUpdates()) return;
      const message = cause instanceof Error && cause.name === 'Error' ? cause.message : 'Не удалось получить ответы. Запрос мог быть принят сервером. Автоматический повтор отключён.';
      setError(message);
      setRecoverPrompt(input.prompt);
      setTurn((current) => current?.turnId === input.turnId ? {
        ...current, results: { ...current.results, ...Object.fromEntries(targets.filter((target) => current.results[target.columnId]?.status === 'pending').map((target) => [target.columnId, { status: 'network_error' as const, attemptId: target.attemptId, message, text: current.results[target.columnId]?.text ?? '', reasoning: current.results[target.columnId]?.reasoning ?? '' }])) },
      } : current);
      if ('targets' in input) setDraft((current) => current || input.prompt);
    } finally {
      if (controller.current === transport) {
        controller.current = null;
        lock.current = false;
        if (!transport.signal.aborted) setBusy(false);
      }
    }
  }

  function stop() {
    const transport = controller.current;
    if (!transport) return;
    transport.abort();
    controller.current = null;
    lock.current = false;
    setBusy(false);
    setTurn((current) => current ? { ...current, results: Object.fromEntries(Object.entries(current.results).map(([id, result]) =>
      [id, result.status === 'pending' ? { status: 'stopped', ...(result.attemptId ? { attemptId: result.attemptId } : {}), text: result.text ?? '', reasoning: result.reasoning ?? '', message: 'Запрос остановлен. Полученный текст сохранён.' } : result])) } : current);
  }

  function submit() {
    if (lock.current || workspaceLocked) return;
    const parsed = comparisonRequestSchema.safeParse({
      protocolVersion: 1, serializerVersion: 1, conversationId, runId: crypto.randomUUID(), turnId: crypto.randomUUID(), prompt: draft,
      targets: columns.map((column) => ({ columnId: column.columnId, modelId: column.model.id, attemptId: crypto.randomUUID(), history: buildHistory([...pastTurns, ...(turn ? [turn] : [])], column.columnId) })),
    });
    if (!parsed.success) { setError('Не удалось продолжить: проверьте вопрос и выбор моделей. Контекст ограничен 16 парами и 64 КиБ; при превышении начните новое сравнение.'); return; }
    void execute(parsed.data);
  }

  function retry(column: Column) {
    if (!turn || lock.current || catalogController.current || catalogError || workspaceLocked || !availableIds.has(column.model.id)) return;
    const result = turn.results[column.columnId];
    if (!result || result.status === 'pending' || result.status === 'succeeded') return;
    const snapshot = turn.targets.find((target) => target.columnId === column.columnId);
    if (!snapshot) return;
    const input = retryRequestSchema.safeParse({
      protocolVersion: 1, serializerVersion: turn.serializerVersion, conversationId, runId: crypto.randomUUID(), turnId: turn.turnId, prompt: turn.prompt,
      target: { ...snapshot, attemptId: crypto.randomUUID() },
    });
    if (!input.success) { setError('Контекст повтора недоступен. Начните новое сравнение.'); return; }
    void execute(input.data);
  }

  function removeColumn(columnId: string) {
    if (lock.current || workspaceLocked || columns.length <= 2) return;
    const index = columns.findIndex((column) => column.columnId === columnId);
    if (selectedId === columnId) setActiveColumn(columns[index + 1]?.columnId ?? columns[index - 1]!.columnId);
    setColumns((current) => current.filter((column) => column.columnId !== columnId));
  }

  async function reset() {
    if (lock.current || catalogController.current || workspaceLocked) return;
    if (beforeReset && !await beforeReset()) return;
    if (hasUnavailable) {
      const updated = conversationMode === catalog.mode ? columns.filter((column) => availableIds.has(column.model.id)) : [];
      for (const model of catalog.models) {
        if (updated.length >= Math.max(2, columns.length)) break;
        if (!updated.some((column) => column.model.id === model.id)) updated.push(createColumn(model));
      }
      setColumns(updated);
    }
    setTurn(null); setPastTurns([]); setConversationId(crypto.randomUUID()); setConversationMode(catalog.mode); setError(''); setRecoverPrompt('');
  }

  const views = turn ? [...pastTurns, turn] : [];
  const firstView = views[0];
  const selectedColumn = columns.find((column) => column.columnId === selectedId);
  const removeButton = (column: Column) => <button type="button" className="icon-button" aria-label={`Удалить ${column.model.displayName}`}
    title={columns.length <= 2 ? 'Минимум две модели' : 'Удалить модель'}
    disabled={busy || catalogRefreshing || workspaceLocked || columns.length <= 2} onClick={() => removeColumn(column.columnId)}>×</button>;
  const contextNote = (column: Column) => skippedTurns(views, column.columnId) > 0 &&
    <p className="context-note">Неуспешные ходы пропускаются в контексте этой модели. Последний ответ можно повторить перед продолжением.</p>;
  const modelTools = <div className="model-tools" role="group" aria-label="Управление моделями">
    {turn && mobile && selectedColumn && columns.length > 2 && removeButton(selectedColumn)}
    <button type="button" ref={addButton} disabled={busy || catalogBlocked || columns.length >= 4 || catalog.models.length <= columns.length}
      aria-label="Добавить модель" onClick={() => setPicker(true)}><span aria-hidden="true">{turn ? `Модели · ${columns.length}` : '+ Модели'}</span></button>
    <button type="button" className="refresh-models" disabled={busy || catalogRefreshing || workspaceLocked}
      aria-label="Обновить модели" title={catalogRefreshing ? 'Обновление…' : 'Обновить модели'}
      onClick={() => { void refreshCatalog(); }}><span aria-hidden="true">↻</span></button>
  </div>;

  return <>
    <WorkspaceHeader mode={catalog.mode === 'mock' ? 'Демо' : 'Live'} history={history} actions={(turn || hasUnavailable) && <div className="toolbar-actions">
      <button onClick={reset} aria-label="Новое сравнение" disabled={busy || catalogRefreshing || workspaceLocked}>
        <span aria-hidden="true">+ </span><span className="new-comparison-label">Новое сравнение</span><span className="new-comparison-short" aria-hidden="true">Новое</span>
      </button>
    </div>} />
    {notices}
    {catalog.models.length < 2 && <p className="notice" role="alert">Для сравнения нужны хотя бы две доступные модели.</p>}
    {hasUnavailable && catalog.models.length >= 2 && <p className="notice" role="alert">Выбранная модель больше недоступна. Начните новое сравнение, чтобы выбрать доступные модели. Прежние ответы сохранены до сброса.</p>}
    {catalogError && <p className="run-error" role="alert">{catalogError}</p>}
    <div className={turn ? 'workspace' : 'workspace workspace-start'}>
    {firstView ? <div className="comparison-viewport"><div className="comparison-scroll" style={{ '--columns': columns.length } as CSSProperties}>
      <div className="question-bar">
        <div className="question"><span>Ваш вопрос</span><p>{firstView.prompt}</p></div>
        {modelTools}
      </div>
      {!mobile && <div className="column-links" aria-hidden="true">
        {columns.map((column) => <span key={column.columnId} />)}
      </div>}
      {mobile && <div className="mobile-tabs" role="tablist" aria-label="Модели" onKeyDown={(event) => {
        const index = columns.findIndex((column) => column.columnId === selectedId);
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % columns.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + columns.length) % columns.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = columns.length - 1;
        else return;
        event.preventDefault();
        const id = columns[next]?.columnId;
        if (id) { setActiveColumn(id); document.getElementById(`tab-${id}`)?.focus(); }
      }}>
        {columns.map((column) => <button key={column.columnId} id={`tab-${column.columnId}`} role="tab" aria-selected={selectedId === column.columnId}
          aria-controls={`panel-${column.columnId}`} tabIndex={selectedId === column.columnId ? 0 : -1} onClick={() => setActiveColumn(column.columnId)}>
          {modelName(column.model)}<small>{statusText(turn?.results[column.columnId])}</small>
        </button>)}
      </div>}
      <div className="comparison-grid">
        {mobile ? selectedColumn && contextNote(selectedColumn) : columns.map((column) => <div key={column.columnId} className={`column-heading ${selectedId === column.columnId ? 'is-selected' : ''}`}>
          <div><h2 aria-label={column.model.displayName}>{modelName(column.model)}</h2>
            {column.model.metadataSource !== 'mock' && <p>{column.model.provider}</p>}
            {contextNote(column)}
          </div>
          {views.length === 1 && <span className="column-status">{statusText(turn?.results[column.columnId])}</span>}
          {removeButton(column)}
        </div>)}
        {views.map((view, index) => {
          const visible = Object.fromEntries(columns.flatMap((column) => view.results[column.columnId] ? [[column.columnId, view.results[column.columnId]!]] : []));
          const leaders = comparisonLeaders(visible, view !== turn || !busy);
          return <Fragment key={view.turnId}>
          {index > 0 && <div className="question next-question"><span>Ваш вопрос</span><p>{view.prompt}</p></div>}
          {columns.map((column) => <section key={column.columnId} id={view === turn ? `panel-${column.columnId}` : `panel-${view.turnId}-${column.columnId}`}
            role={mobile && view === turn ? 'tabpanel' : 'region'} hidden={mobile && selectedId !== column.columnId}
            aria-labelledby={mobile && view === turn ? `tab-${column.columnId}` : undefined}
            className={`answer-cell${index > 0 ? ' continued-turn' : ''}${selectedId === column.columnId ? ' is-selected' : ''}`} aria-label={`Ответ ${column.model.displayName}`}>
            <Answer result={view.results[column.columnId]} retry={view === turn ? () => retry(column) : undefined} disabled={busy || catalogBlocked || conversationMode !== catalog.mode || !availableIds.has(column.model.id)}
              totalLeader={leaders.total.has(column.columnId)} firstAnswerLeader={leaders.firstAnswer.has(column.columnId)} costLeader={leaders.cost.has(column.columnId)} />
          </section>)}
        </Fragment>;
        })}
      </div>
    </div></div> : <div className="start-intro">
      <span className="start-mark" aria-hidden="true"><i /><i /></span>
      <h1 className="start-title">Новое сравнение</h1>
    </div>}
    {error && <div className="run-error" role="alert"><p>{error}</p>{recoverPrompt && recoverPrompt !== draft && <button onClick={() => setDraft(recoverPrompt)}>Восстановить отправленный вопрос</button>}</div>}
    <div className="run-status" role="status">{busy ? 'Ответы поступают. Генерацию можно остановить.' : turn ? 'Сравнение завершено.' : ''}</div>
    <Composer draft={draft} onChange={setDraft} onSubmit={submit} onStop={stop} busy={busy} disabled={hasUnavailable || catalogBlocked} readOnly={workspaceLocked} followUp={Boolean(turn)}
      modelControls={!turn && <div className="composer-models">
        {columns.map((column) => <div className="model-chip" key={column.columnId}><h2 aria-label={column.model.displayName}>{modelName(column.model)}</h2>{removeButton(column)}</div>)}
        {modelTools}
      </div>} />
    </div>
    {picker && <ModelPicker returnFocus={addButton.current} models={catalog.models} selectedIds={columns.map((column) => column.model.id)} onClose={closePicker} onSelect={(model) => {
      if (lock.current || workspaceLocked || columns.length >= 4 || columns.some((column) => column.model.id === model.id)) return;
      setColumns((current) => [...current, createColumn(model)]); closePicker();
    }} />}
  </>;
}
