import { Fragment, memo, useContext, useMemo } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toHast } from 'mdast-util-to-hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Nodes } from 'hast';
import type { Root } from 'mdast';
import type { AstBlock } from './engine';
import { CodeBlock, safeMarkdownUrl } from './controls';
import { RevealContext, RevealText } from './RevealText';

export function renderAst(ast: Root, reveal?: Pick<AstBlock, 'from' | 'to' | 'prefixLength' | 'trailingWhitespace'>) {
  const hast = toHast(ast);
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
        if (href) node.properties = { ...node.properties, href, target: '_blank', rel: ['noopener', 'noreferrer'] };
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

export const AstView = memo(function AstView({ block }: { block: AstBlock }) {
  const reveal = useContext(RevealContext);
  return useMemo(() => renderAst(block.ast, reveal ? block : undefined), [block, reveal]);
});
