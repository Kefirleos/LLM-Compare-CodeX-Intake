import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ModelDescriptor } from '@llm-compare/contracts';

interface Props {
  models: ModelDescriptor[];
  selectedIds: string[];
  onSelect: (model: ModelDescriptor) => void;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  anchorRef: RefObject<HTMLElement | null> | null;
}

function positionPicker(dialog: HTMLDialogElement, anchor: HTMLElement | null) {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const inset = 12;
  const gap = 8;
  const bounds = anchor?.getBoundingClientRect();
  if (!bounds) { delete dialog.dataset.placement; return; }
  const below = top + height - bounds.bottom - gap - inset;
  const above = bounds.top - top - gap - inset;
  const openBelow = below >= 280 || below >= above;
  const available = openBelow ? below : above;
  if (available < 160) { delete dialog.dataset.placement; return; }
  const pickerWidth = Math.min(330, width - 2 * inset);
  dialog.dataset.placement = openBelow ? 'below' : 'above';
  dialog.style.setProperty('--picker-x', `${Math.max(left + inset, Math.min(bounds.right - pickerWidth, left + width - pickerWidth - inset))}px`);
  dialog.style.setProperty('--picker-y', `${openBelow ? bounds.bottom + gap : bounds.top - gap}px`);
  dialog.style.setProperty('--picker-width', `${pickerWidth}px`);
  dialog.style.setProperty('--picker-space', `${available}px`);
}

export function ModelPicker({ models, selectedIds, onSelect, onClose, triggerRef, anchorRef }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [search, setSearch] = useState('');
  useLayoutEffect(() => {
    const element = dialog.current!;
    const position = () => positionPicker(element, anchorRef?.current ?? null);
    element.showModal();
    position();
    element.querySelector('input')?.focus();
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    return () => {
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      element.close();
      queueMicrotask(() => {
        if (element.open) return;
        const trigger = triggerRef.current;
        if (trigger && !trigger.disabled) trigger.focus({ preventScroll: true });
        else document.getElementById('prompt')?.focus();
      });
    };
  }, [triggerRef, anchorRef]);
  const query = search.trim().toLocaleLowerCase();
  const filtered = models.filter((model) => `${model.displayName} ${model.provider}`.toLocaleLowerCase().includes(query));

  return <dialog ref={dialog} className="model-picker" aria-labelledby="picker-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) onClose();
  }} onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <div className="picker-heading"><h2 id="picker-title">Добавить модель</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть выбор моделей">×</button></div>
    <label className="field-label" htmlFor="model-search">Поиск по названию или провайдеру</label>
    <input id="model-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
    <ul className="picker-list">{filtered.map((model) => <li key={model.id}>
      <button disabled={selectedIds.includes(model.id)} onClick={() => onSelect(model)}>
        <strong>{model.displayName}</strong><span>{model.provider}{selectedIds.includes(model.id) ? ' · Уже выбрана' : ''}</span>
      </button>
    </li>)}</ul>
    {filtered.length === 0 && <p className="muted" role="status">Ничего не найдено.</p>}
  </dialog>;
}
