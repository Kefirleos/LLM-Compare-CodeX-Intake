import { useEffect, useRef, useState } from 'react';
import type { ModelDescriptor } from '@llm-compare/contracts';

interface Props {
  models: ModelDescriptor[];
  selectedIds: string[];
  onSelect: (model: ModelDescriptor) => void;
  onClose: () => void;
}

export function ModelPicker({ models, selectedIds, onSelect, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    element.querySelector('input')?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLButtonElement && previous.disabled) document.getElementById('prompt')?.focus();
      else if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const query = search.trim().toLocaleLowerCase();
  const filtered = models.filter((model) => `${model.displayName} ${model.provider}`.toLocaleLowerCase().includes(query));

  return <dialog ref={dialog} className="model-picker" aria-labelledby="picker-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="picker-heading"><h2 id="picker-title">Добавить модель</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть выбор моделей">×</button></div>
    <label className="field-label" htmlFor="model-search">Поиск по названию или провайдеру</label>
    <input id="model-search" autoFocus type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
    <ul className="picker-list">{filtered.map((model) => <li key={model.id}>
      <button disabled={selectedIds.includes(model.id)} onClick={() => onSelect(model)}>
        <strong>{model.displayName}</strong><span>{model.provider}{selectedIds.includes(model.id) ? ' · Уже выбрана' : ''}</span>
      </button>
    </li>)}</ul>
    {filtered.length === 0 && <p className="muted" role="status">Ничего не найдено.</p>}
  </dialog>;
}
