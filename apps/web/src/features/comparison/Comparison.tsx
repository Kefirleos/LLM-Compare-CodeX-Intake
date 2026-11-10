import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { comparisonRequestSchema, retryRequestSchema } from '@llm-compare/contracts';
import type { AttemptResult, ComparisonRequest, ModelCatalog, ModelDescriptor, RetryRequest } from '@llm-compare/contracts';
import { sendComparison } from '../../api/comparisons';
import { Composer } from '../composer/Composer';
import { ModelPicker } from '../models/ModelPicker';

type Column = { columnId: string; model: ModelDescriptor };
type DisplayResult = AttemptResult | { status: 'pending' } | { status: 'network_error'; message: string };
type Turn = { turnId: string; prompt: string; results: Record<string, DisplayResult> };

const createColumn = (model: ModelDescriptor): Column => ({ columnId: crypto.randomUUID(), model });
const statusText = (result?: DisplayResult) => {
  if (!result) return 'Готова к вопросу';
  return { pending: 'Получение ответа…', succeeded: 'Готово', failed: 'Ошибка', timed_out: 'Таймаут', cancelled: 'Прервано', network_error: 'Соединение прервано' }[result.status];
};

export function Comparison({ catalog }: { catalog: ModelCatalog }) {
  const [conversationId] = useState(() => crypto.randomUUID());
  const [columns, setColumns] = useState<Column[]>(() => catalog.models.slice(0, 2).map(createColumn));
  const [activeColumn, setActiveColumn] = useState('');
  const [draft, setDraft] = useState('');
  const [turn, setTurn] = useState<Turn | null>(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState('');
  const [recoverPrompt, setRecoverPrompt] = useState('');
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 1000px)').matches);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const selectedId = columns.some((column) => column.columnId === activeColumn) ? activeColumn : columns[0]?.columnId;

  useEffect(() => () => controller.current?.abort(), []);
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

  async function execute(input: ComparisonRequest | RetryRequest) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setRecoverPrompt('');
    const targets = 'targets' in input ? input.targets : [input.target];
    const pending = Object.fromEntries(targets.map((target) => [target.columnId, { status: 'pending' as const }]));
    if ('targets' in input) {
      setTurn({ turnId: input.turnId, prompt: input.prompt, results: pending });
      setDraft('');
    } else setTurn((current) => current ? { ...current, results: { ...current.results, ...pending } } : current);
    const transport = new AbortController();
    controller.current = transport;
    try {
      const response = await sendComparison(input, transport.signal);
      if (transport.signal.aborted) return;
      const results = Object.fromEntries(response.results.map((result) => [result.columnId, result]));
      setTurn((current) => current?.turnId === input.turnId ? { ...current, results: { ...current.results, ...results } } : current);
    } catch (cause) {
      if (transport.signal.aborted) return;
      const message = cause instanceof Error && cause.name === 'Error' ? cause.message : 'Не удалось получить ответы. Запрос мог быть принят сервером. Автоматический повтор отключён.';
      setError(message);
      setRecoverPrompt(input.prompt);
      setTurn((current) => current?.turnId === input.turnId ? {
        ...current, results: { ...current.results, ...Object.fromEntries(targets.map((target) => [target.columnId, { status: 'network_error' as const, message }])) },
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

  function submit() {
    if (lock.current) return;
    const parsed = comparisonRequestSchema.safeParse({
      protocolVersion: 1, conversationId, runId: crypto.randomUUID(), turnId: crypto.randomUUID(), prompt: draft,
      targets: columns.map((column) => ({ columnId: column.columnId, modelId: column.model.id, attemptId: crypto.randomUUID(), history: [] })),
    });
    if (!parsed.success) { setError('Проверьте вопрос и выберите от двух до четырёх моделей.'); return; }
    void execute(parsed.data);
  }

  function retry(column: Column) {
    if (!turn || lock.current) return;
    const result = turn.results[column.columnId];
    if (!result || result.status === 'pending' || result.status === 'succeeded') return;
    const input = retryRequestSchema.parse({
      protocolVersion: 1, conversationId, runId: crypto.randomUUID(), turnId: turn.turnId, prompt: turn.prompt,
      target: { columnId: column.columnId, modelId: column.model.id, attemptId: crypto.randomUUID(), history: [] },
    });
    void execute(input);
  }

  function removeColumn(columnId: string) {
    if (lock.current || columns.length <= 2) return;
    const index = columns.findIndex((column) => column.columnId === columnId);
    if (selectedId === columnId) setActiveColumn(columns[index + 1]?.columnId ?? columns[index - 1]!.columnId);
    setColumns((current) => current.filter((column) => column.columnId !== columnId));
  }

  function reset() {
    if (lock.current) return;
    setTurn(null); setError(''); setRecoverPrompt('');
  }

  return <>
    <div className="workspace-toolbar"><span className="badge">{catalog.mode === 'mock' ? 'Демо-режим' : 'Live'}</span><button onClick={reset} disabled={busy || !turn}>Новое сравнение</button></div>
    <p className="demo-note">Тестовые ответы без обращения к языковым моделям. Каждый вопрос — отдельное сравнение, без контекста предыдущих вопросов.</p>
    {catalog.models.length < 2 && <p className="notice" role="alert">Для сравнения нужны хотя бы две доступные модели.</p>}
    <div className="comparison-scroll">
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
          {column.model.displayName}<small>{statusText(turn?.results[column.columnId])}</small>
        </button>)}
      </div>}
      <div className="comparison-grid" style={{ '--columns': columns.length } as CSSProperties}>
        {columns.map((column) => <div key={column.columnId} className={`column-heading ${selectedId === column.columnId ? 'is-selected' : ''}`}>
          <div><h2>{column.model.displayName}</h2><p>{column.model.provider}</p></div>
          <button className="icon-button" aria-label={`Удалить ${column.model.displayName}`} title={columns.length <= 2 ? 'Минимум две модели' : 'Удалить модель'}
            disabled={busy || columns.length <= 2} onClick={() => removeColumn(column.columnId)}>×</button>
        </div>)}
        <div className="add-column"><button ref={addButton} disabled={busy || columns.length >= 4 || catalog.models.length <= columns.length} aria-label="Добавить модель" onClick={() => setPicker(true)}>+</button></div>
        {turn && <div className="question"><span>Ваш вопрос</span><p>{turn.prompt}</p></div>}
        {!turn && <div className="empty-comparison"><p className="eyebrow">СРАВНЕНИЕ МОДЕЛЕЙ</p><h1>Один вопрос.<br /><span>Несколько ответов.</span></h1><p>Выберите 2–4 модели и задайте вопрос ниже.</p></div>}
        {columns.map((column) => {
          const result = turn?.results[column.columnId];
          return <section key={column.columnId} id={`panel-${column.columnId}`} role={mobile ? 'tabpanel' : 'region'}
            hidden={!turn || (mobile && selectedId !== column.columnId)} aria-labelledby={mobile ? `tab-${column.columnId}` : undefined}
            className={`answer-cell ${selectedId === column.columnId ? 'is-selected' : ''}`} aria-label={`Ответ ${column.model.displayName}`}>
            {result?.status === 'succeeded' ? <><div className="answer-text">{result.text}</div><p className="answer-time">{(result.totalMs / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} с</p></>
              : result?.status === 'pending' ? <p className="pending" role="status">Получение ответа…</p>
              : result ? <div className="answer-error"><strong>{statusText(result)}</strong><p>{result.status === 'network_error' ? result.message : result.error.message}</p>
                {result.status !== 'network_error' && <p className="answer-time">{(result.totalMs / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} с</p>}
                {(result.status === 'network_error' || result.error.retryable) && <button disabled={busy} onClick={() => retry(column)}>Повторить ответ</button>}
              </div> : <p className="muted">Модель добавлена после отправки вопроса. Ответ появится при следующем сравнении.</p>}
          </section>;
        })}
      </div>
    </div>
    {error && <div className="run-error" role="alert"><p>{error}</p>{recoverPrompt && recoverPrompt !== draft && <button onClick={() => setDraft(recoverPrompt)}>Восстановить отправленный вопрос</button>}</div>}
    <div className="run-status" role="status">{busy ? 'Запрос отправлен всем выбранным моделям. Дождитесь завершения.' : turn ? 'Сравнение завершено.' : ''}</div>
    <Composer draft={draft} onChange={setDraft} onSubmit={submit} busy={busy} disabled={columns.length < 2} />
    {picker && <ModelPicker models={catalog.models} selectedIds={columns.map((column) => column.model.id)} onClose={closePicker} onSelect={(model) => {
      if (lock.current || columns.length >= 4 || columns.some((column) => column.model.id === model.id)) return;
      setColumns((current) => [...current, createColumn(model)]); closePicker();
    }} />}
  </>;
}
