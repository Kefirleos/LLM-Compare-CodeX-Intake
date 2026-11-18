import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownEngine } from './engine';
import type { AstBlock } from './engine';
import { MarkdownSession } from './session';
import { MarkdownWorkerPool } from './workerPool';
import { AstView, FootnoteView } from './AstView';
import { FootnotePlanner } from './footnotes';
import { MarkdownBoundary } from './controls';
import { RevealContext } from './RevealText';
import { browserRevealScheduler, RevealDocument } from './reveal';
export { safeMarkdownUrl, MarkdownBoundary } from './controls';

const workers = new MarkdownWorkerPool(() => new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' }));
const emptyBlocks: readonly AstBlock[] = [];

function MarkdownContent({ parsed, text, finalized }: { parsed: readonly AstBlock[] | null; text: string; finalized: boolean }) {
  const blocks = parsed ?? emptyBlocks;
  const id = useId();
  const footnotes = useMemo(() => new FootnotePlanner(`llm-note-${encodeURIComponent(id).replaceAll('%', '_')}-`), [id]);
  const { calls, footer } = useMemo(() => footnotes.update(blocks), [blocks, footnotes]);
  return <div className="markdown" aria-busy={parsed === null || undefined}>
    {blocks.length ? blocks.map((block) => <AstView key={block.id} block={block} calls={calls.get(block)} />)
      : finalized && parsed !== null ? <pre className="markdown-raw">{text}</pre> : <span aria-hidden="true">…</span>}
    {footer && <FootnoteView footer={footer} />}
  </div>;
}

export const MarkdownAnswer = memo(function MarkdownAnswer({ text, documentId = 'answer', finalized = true }: { text: string; documentId?: string; finalized?: boolean }) {
  const [blocks, setBlocks] = useState<readonly AstBlock[] | null>(() => typeof Worker === 'undefined' ? new MarkdownEngine().update(text).blocks : null);
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
    setBlocks(null);
    const current = new MarkdownSession(documentId, (value) => setBlocks(value), setError,
      typeof Worker === 'undefined' ? undefined : (streaming) => workers.open(streaming));
    session.current = current;
    return () => { current.dispose(); if (session.current === current) session.current = null; };
  }, [documentId]);
  useEffect(() => { session.current?.update(text, finalized); }, [text, finalized, documentId]);
  return <MarkdownBoundary text={text}>
    {error ? <div className="markdown-fallback"><p role="status">{error}</p><pre>{text}</pre></div>
      : <RevealContext value={canAnimate ? reveal : null}><MarkdownContent parsed={blocks} text={text} finalized={finalized} /></RevealContext>}
  </MarkdownBoundary>;
});
