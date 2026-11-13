import type { ReactNode } from 'react';

export function WorkspaceHeader({ actions, history }: { actions?: ReactNode; history?: ReactNode }) {
  return <header className="topbar">
    <a className="brand" href="/">LLM Compare<span className="brand-dot" aria-hidden="true" /></a>
    {actions}
    {history}
  </header>;
}
