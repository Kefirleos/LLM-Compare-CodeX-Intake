import { Fragment, memo, useContext, useMemo } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toHast } from 'mdast-util-to-hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Element, Nodes } from 'hast';
import type { FootnoteReference } from 'mdast';
import type { AstBlock } from './engine';
import type { FootnoteCalls } from './footnotes';
import { CodeBlock, safeMarkdownUrl } from './controls';
import { RevealContext, RevealText } from './RevealText';

function renderHast(hast: Nodes, reveal?: AstBlock) {
  function sanitize(node: Nodes, skipReveal = false): Nodes {
    if (reveal && !skipReveal && node.type === 'text' && node.value.trim() && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      const start = reveal.from + node.position.start.offset - reveal.prefixLength;
      const end = reveal.from + node.position.end.offset - reveal.prefixLength;
      if (start >= reveal.from && end <= reveal.to) return { type: 'element', tagName: 'span', properties: {
        'data-reveal-start': start, 'data-reveal-end': end, 'data-reveal-sealed': reveal.trailingWhitespace || end < reveal.to ? 1 : 0,
      }, children: [{ type: 'text', value: node.value }] };
    }
    if (node.type === 'element') {
      if (node.tagName === 'img') {
        const alt = String(node.properties.alt ?? '');
        node.tagName = 'span'; node.properties = { className: ['blocked-image'] };
        node.children = [{ type: 'text', value: `Изображение не загружено${alt ? `: ${alt}` : ''}` }];
      } else if (node.tagName === 'a') {
        const href = safeMarkdownUrl(String(node.properties.href ?? ''));
        if (href && (node.properties.dataFootnoteRef === true || node.properties.dataFootnoteBackref === '')) node.properties.href = href;
        else if (href) node.properties = { ...node.properties, href, target: '_blank', rel: ['noopener', 'noreferrer'] };
        else { node.tagName = 'span'; node.properties = {}; }
      }
    }
    if ('children' in node) node.children = node.children.map((child) => sanitize(child, skipReveal || (node.type === 'element' && ['pre', 'code', 'table', 'input'].includes(node.tagName)))) as typeof node.children;
    return node;
  }
  sanitize(hast);
  return toJsxRuntime(hast, { Fragment, jsx, jsxs, components: {
    pre: CodeBlock,
    span: RevealText,
    table: ({ children }) => <div className="markdown-table" tabIndex={0} aria-label="Таблица с горизонтальной прокруткой"><table>{children}</table></div>,
  } });
}

export const AstView = memo(function AstView({ block, calls }: { block: AstBlock; calls: FootnoteCalls | undefined }) {
  const reveal = useContext(RevealContext);
  return useMemo(() => renderHast(toHast(block.ast, { handlers: {
    footnoteReference(_state, node: FootnoteReference) {
      const call = calls?.get(node);
      return call ? structuredClone(call) : { type: 'text', value: `[^${node.label ?? node.identifier}]` };
    },
  } }), reveal ? block : undefined), [block, calls, reveal]);
});

export const FootnoteView = memo(function FootnoteView({ footer }: { footer: Element }) {
  return useMemo(() => renderHast(structuredClone(footer)), [footer]);
});
