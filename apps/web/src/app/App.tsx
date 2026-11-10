import { useEffect, useState } from 'react';
import type { ModelCatalog } from '@llm-compare/contracts';
import { fetchCatalog } from '../api/catalog';

type CatalogState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; catalog: ModelCatalog };

export function App() {
  const [state, setState] = useState<CatalogState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void fetchCatalog(controller.signal).then((catalog) => {
      if (!controller.signal.aborted) setState({ status: 'ready', catalog });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: 'error' });
    });
    return () => controller.abort();
  }, [revision]);

  return (
    <div className="shell">
      <header className="topbar"><a className="brand" href="/">LLM Compare<span className="brand-dot" aria-hidden="true" /></a></header>
      <main>
        <div className="intro">
          <p className="eyebrow">КАТАЛОГ МОДЕЛЕЙ</p>
          <h1>Несколько точек зрения.<br /><span>Один вопрос.</span></h1>
        </div>
        <section aria-labelledby="catalog-heading" aria-busy={state.status === 'loading'}>
          <div className="section-heading">
            <h2 id="catalog-heading">Доступные модели</h2>
            {state.status === 'ready' && <span className="badge">{state.catalog.mode === 'mock' ? 'Демо-режим' : 'Live'}</span>}
          </div>
          {state.status === 'loading' && <p className="notice" role="status">Загрузка каталога…</p>}
          {state.status === 'error' && <div className="notice" role="alert"><p>Не удалось загрузить модели.</p><button onClick={() => setRevision((value) => value + 1)}>Повторить</button></div>}
          {state.status === 'ready' && <>
            <p className="description">{state.catalog.mode === 'mock' ? 'Тестовые модели с заранее заданными ответами. Запросы к языковым моделям не выполняются.' : 'Каталог моделей сервера.'}</p>
            {state.catalog.models.length === 0 ? <p className="notice">В каталоге пока нет моделей.</p> : <ul className="model-grid">{state.catalog.models.map((model, index) => <li className="model-card" key={model.id}>
              <span className="model-number" aria-hidden="true">0{index + 1}</span>
              <h3>{model.displayName}</h3><p>{model.provider}</p>
            </li>)}</ul>}
          </>}
        </section>
      </main>
      <footer>LLM Compare</footer>
    </div>
  );
}
