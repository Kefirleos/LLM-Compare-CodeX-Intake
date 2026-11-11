import { Fragment, memo } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toHast } from 'mdast-util-to-hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Nodes } from 'hast';
import type { Root } from 'mdast';
import type { AstBlock } from './engine';
import { CodeBlock, safeMarkdownUrl } from './controls';

export function renderAst(ast: Root) {
  const hast = toHast(ast);
  function sanitize(node: Nodes) {
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
    if ('children' in node) node.children.forEach(sanitize);
  }
  sanitize(hast);
  return toJsxRuntime(hast, { Fragment, jsx, jsxs, components: {
    pre: CodeBlock,
    table: ({ children }) => <div className="markdown-table" tabIndex={0} aria-label="Таблица с горизонтальной прокруткой"><table>{children}</table></div>,
  } });
}

export const AstView = memo(function AstView({ block }: { block: AstBlock }) { return renderAst(block.ast); });
