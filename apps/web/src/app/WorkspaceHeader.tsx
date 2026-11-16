import type { ReactNode } from 'react';

export function WorkspaceHeader({ mode, actions, history }: { mode?: string; actions?: ReactNode; history?: ReactNode }) {
  return <header className="topbar">
    <div className="brand-group">
      <a className="brand" href="/"><span className="brand-mark" aria-hidden="true" />LLM Compare</a>
      {mode && <span className="badge">{mode}</span>}
    </div>
    {actions}
    {history}
  </header>;
}
