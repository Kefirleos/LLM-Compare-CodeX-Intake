import { Children, Component, isValidElement, useEffect, useState } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

export function safeMarkdownUrl(url: string, key = 'href'): string | undefined {
  // oxlint-disable-next-line no-control-regex -- Reject ASCII control characters before parsing the URL.
  if (key !== 'href' || !url || url !== url.trim() || /[\u0000-\u0020\u007f\\]/.test(url) || url.startsWith('//')) return;
  try {
    const parsed = new URL(url, 'https://markdown.invalid/');
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
    if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) return;
    return url;
  } catch { return; }
}

export function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
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
