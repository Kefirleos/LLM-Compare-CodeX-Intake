import { useEffect, useId, useState } from 'react';

export function Thinking({ text, active, interrupted, durationMs }: { text: string; active: boolean; interrupted: boolean; durationMs: number | undefined }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const id = useId();
  useEffect(() => setExpanded(null), [active]);
  if (!text && !active) return null;
  const open = expanded ?? active;
  return <div className={`thinking${active ? ' is-active' : ''}`}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setExpanded(!open)}>
      {active ? 'Thinking…' : interrupted ? 'Thinking · прервано' : 'Thinking'}
      {durationMs !== undefined && ` · ${(durationMs / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} с`}
      <span aria-hidden="true">{open ? ' ▴' : ' ▾'}</span>
    </button>
    <div id={id} hidden={!open} className="thinking-text">{text || 'Модель начала рассуждение…'}</div>
  </div>;
}
