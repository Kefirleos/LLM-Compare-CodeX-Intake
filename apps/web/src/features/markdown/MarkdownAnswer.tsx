import { Children, Component, isValidElement, memo, useEffect, useState } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function safeMarkdownUrl(url: string, key = 'href'): string | undefined {
  if (key !== 'href' || !url || url !== url.trim() || /[\u0000-\u0020\u007f\\]/.test(url) || url.startsWith('//')) return;
  try {
    const parsed = new URL(url, 'https://markdown.invalid/');
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
    if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) return;
    return url;
  } catch { return; }
}

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const child = Children.toArray(children)[0];
  const text = isValidElement<{ children?: ReactNode }>(child) && typeof child.props.children === 'string'
    ? child.props.children : null;
  const [status, setStatus] = useState('');
  useEffect(() => setStatus(''), [text]);
  return <div className="code-block">
    <div className="code-toolbar"><span>Код</span>{text !== null && <button type="button" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setStatus('Скопировано');
      } catch { setStatus('Не удалось скопировать'); }
    }}>Скопировать код</button>}<span role="status">{status}</span></div>
    <pre {...props}>{children}</pre>
  </div>;
}

export class MarkdownBoundary extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: Readonly<{ text: string; children: ReactNode }>) {
    if (previous.text !== this.props.text && this.state.failed) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? <div className="markdown-fallback">
      <p role="status">Не удалось отобразить форматирование. Исходный ответ сохранён ниже.</p>
      <pre>{this.props.text}</pre>
    </div> : this.props.children;
  }
}

export const MarkdownAnswer = memo(function MarkdownAnswer({ text }: { text: string }) {
  return <MarkdownBoundary text={text}><div className="markdown">
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl} components={{
      a: ({ href, children }) => href
        ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>,
      img: ({ alt }) => <span className="blocked-image">Изображение не загружено{alt ? `: ${alt}` : ''}</span>,
      table: ({ children }) => <div className="markdown-table" tabIndex={0} aria-label="Таблица с горизонтальной прокруткой"><table>{children}</table></div>,
      pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
    }}>{text}</ReactMarkdown>
  </div></MarkdownBoundary>;
});
