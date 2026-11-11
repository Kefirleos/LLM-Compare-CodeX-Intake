import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MAX_PROMPT_BYTES, utf8Bytes } from '@llm-compare/contracts';
import type { FormEvent } from 'react';

interface Props {
  draft: string;
  busy: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  readOnly?: boolean;
}

export function Composer({ draft, busy, disabled, onChange, onSubmit, onStop, readOnly = false }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [validation, setValidation] = useState('');
  const resize = () => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    const height = Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight);
    element.style.height = `${Math.max(48, Math.min(element.scrollHeight, 180, height * .2))}px`;
  };
  useLayoutEffect(resize, [draft]);
  useEffect(() => {
    window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); };
  }, []);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy || disabled) return;
    if (!draft.trim()) { setValidation('Введите вопрос.'); return; }
    if (utf8Bytes(draft) > MAX_PROMPT_BYTES) { setValidation('Вопрос превышает 16 КиБ. Сократите текст.'); return; }
    setValidation('');
    onSubmit();
  }

  return <form className="composer" onSubmit={submit}>
    <label htmlFor="prompt" className="field-label">Ваш вопрос</label>
    <div className="composer-input">
      <textarea ref={textarea} id="prompt" placeholder="Задайте вопрос всем выбранным моделям…" rows={2} value={draft} readOnly={readOnly}
        aria-describedby="composer-help composer-error" aria-invalid={Boolean(validation)}
        onChange={(event) => { setValidation(''); onChange(event.target.value); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
            event.preventDefault(); submit();
          }
        }} />
      {busy && onStop ? <button className="submit-button" type="button" onClick={onStop}>Остановить</button>
        : <button className="submit-button" type="submit" disabled={busy || disabled || !draft.trim()}>{busy ? 'Ожидание…' : 'Сравнить'}</button>}
    </div>
    <div className="composer-footer"><span id="composer-help">Enter — отправить · Shift+Enter — новая строка</span><span>{utf8Bytes(draft)} / {MAX_PROMPT_BYTES} байт</span></div>
    <p id="composer-error" className="field-error" role="status">{validation}</p>
  </form>;
}
