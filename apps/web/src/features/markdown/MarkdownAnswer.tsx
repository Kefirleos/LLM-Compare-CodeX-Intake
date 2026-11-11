import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownEngine } from './engine';
import type { AstBlock } from './engine';
import { MarkdownSession } from './session';
import { AstView } from './AstView';
import { MarkdownBoundary } from './controls';
import { RevealContext } from './RevealText';
import { browserRevealScheduler, RevealDocument } from './reveal';
export { safeMarkdownUrl, MarkdownBoundary } from './controls';

export const MarkdownAnswer = memo(function MarkdownAnswer({ text, documentId = 'answer', finalized = true }: { text: string; documentId?: string; finalized?: boolean }) {
  const [blocks, setBlocks] = useState<readonly AstBlock[]>(() => typeof Worker === 'undefined' ? new MarkdownEngine().update(text).blocks : []);
  const [error, setError] = useState('');
  const session = useRef<MarkdownSession | null>(null);
  const canAnimate = typeof Worker !== 'undefined' && typeof requestAnimationFrame === 'function';
  const reveal = useMemo(() => new RevealDocument(browserRevealScheduler, !canAnimate, finalized), [documentId]);
  useLayoutEffect(() => {
    reveal.connect();
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    const update = () => reveal.setImmediate(!canAnimate || document.hidden || Boolean(media?.matches));
    update(); media?.addEventListener('change', update); document.addEventListener('visibilitychange', update);
    return () => { media?.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); reveal.dispose(); };
  }, [reveal, canAnimate]);
  useLayoutEffect(() => { if (finalized) reveal.finish(); }, [finalized, reveal]);
  useEffect(() => {
    setError('');
    setBlocks([]);
    const current = new MarkdownSession(documentId, (value) => setBlocks(value), setError,
      typeof Worker === 'undefined' ? undefined : () => new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' }));
    session.current = current;
    return () => { current.dispose(); if (session.current === current) session.current = null; };
  }, [documentId]);
  useEffect(() => { session.current?.update(text, finalized); }, [text, finalized, documentId]);
  return <MarkdownBoundary text={text}>
    {error ? <div className="markdown-fallback"><p role="status">{error}</p><pre>{text}</pre></div>
      : <RevealContext value={canAnimate ? reveal : null}><div className="markdown">{blocks.length ? blocks.map((block) => <AstView key={block.id} block={block} />)
        : finalized ? <pre className="markdown-raw">{text}</pre> : <span aria-hidden="true">…</span>}</div></RevealContext>}
  </MarkdownBoundary>;
});
