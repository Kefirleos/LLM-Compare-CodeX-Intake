import { memo, useEffect, useRef, useState } from 'react';
import { MarkdownEngine } from './engine';
import type { AstBlock } from './engine';
import { MarkdownSession } from './session';
import { AstView } from './AstView';
import { MarkdownBoundary } from './controls';
export { safeMarkdownUrl, MarkdownBoundary } from './controls';

export const MarkdownAnswer = memo(function MarkdownAnswer({ text, documentId = 'answer', finalized = true }: { text: string; documentId?: string; finalized?: boolean }) {
  const [blocks, setBlocks] = useState<readonly AstBlock[]>(() => typeof Worker === 'undefined' ? new MarkdownEngine().update(text).blocks : []);
  const [error, setError] = useState('');
  const session = useRef<MarkdownSession | null>(null);
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
      : <div className="markdown">{blocks.length ? blocks.map((block) => <AstView key={block.id} block={block} />) : <pre className="markdown-raw">{text}</pre>}</div>}
  </MarkdownBoundary>;
});
