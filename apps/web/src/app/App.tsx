import { useEffect, useState } from 'react';
import type { ModelCatalog } from '@llm-compare/contracts';
import { fetchCatalog } from '../api/catalog';
import { ConversationWorkspace } from '../features/storage/ConversationWorkspace';

type CatalogState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; catalog: ModelCatalog };

export function App() {
  const [state, setState] = useState<CatalogState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void fetchCatalog(controller.signal).then((catalog) => {
      if (!controller.signal.aborted) setState({ status: 'ready', catalog });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setState({ status: 'error', message: cause instanceof Error && cause.name === 'Error' ? cause.message : 'Не удалось загрузить модели.' });
    });
    return () => controller.abort();
  }, [revision]);

  return (
    <div className="shell">
      <header className="topbar"><a className="brand" href="/">LLM Compare<span className="brand-dot" aria-hidden="true" /></a></header>
      <main>
        <section aria-label="Сравнение языковых моделей" aria-busy={state.status === 'loading'}>
          {state.status === 'loading' && <p className="notice" role="status">Загрузка каталога…</p>}
          {state.status === 'error' && <div className="notice" role="alert"><p>{state.message}</p><button onClick={() => setRevision((value) => value + 1)}>Повторить</button></div>}
          <ConversationWorkspace catalog={state.status === 'ready' ? state.catalog : null} />
        </section>
      </main>
      <footer>LLM Compare</footer>
    </div>
  );
}
