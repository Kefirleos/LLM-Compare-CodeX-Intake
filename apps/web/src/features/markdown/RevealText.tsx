import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import type { RevealDocument } from './reveal';

export const RevealContext = createContext<RevealDocument | null>(null);
type Props = ComponentPropsWithoutRef<'span'> & { 'data-reveal-start'?: number; 'data-reveal-end'?: number; 'data-reveal-sealed'?: number };
function Text({ text, start, end, sealed, document }: { text: string; start: number; end: number; sealed: boolean; document: RevealDocument }) {
  const leaf = useMemo(() => document.leaf(start, end, text, sealed), [document, start, end, text, sealed]);
  return useSyncExternalStore(leaf.subscribe, leaf.snapshot, leaf.snapshot);
}
export function RevealText({ children, ...props }: Props) {
  const document = useContext(RevealContext);
  const start = props['data-reveal-start']; const end = props['data-reveal-end'];
  if (!document || start === undefined || end === undefined || typeof children !== 'string') return <span {...props}>{children}</span>;
  return <Text text={children} start={Number(start)} end={Number(end)} sealed={Number(props['data-reveal-sealed']) === 1} document={document} />;
}
