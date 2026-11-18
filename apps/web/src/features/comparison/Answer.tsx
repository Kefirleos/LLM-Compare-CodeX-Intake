import { MarkdownAnswer } from '../markdown/MarkdownAnswer';
import { Thinking } from './Thinking';
import type { DisplayResult } from './history';
import { AttemptMetrics } from './AttemptMetrics';

export function Answer({ result, retry, historical, disabled, totalLeader, firstAnswerLeader, costLeader }: { result: DisplayResult | undefined; retry: (() => void) | undefined; historical: boolean; disabled: boolean; totalLeader: boolean; firstAnswerLeader: boolean; costLeader: boolean }) {
  if (!result) return <p className="muted">Модель добавлена после отправки вопроса. История этой колонки начинается со следующего вопроса.</p>;
  const failed = result.status !== 'succeeded' && result.status !== 'pending';
  const retryable = failed && ('message' in result || result.error?.retryable);
  return <>
    <Thinking text={result.reasoning ?? ''} active={result.status === 'pending' && Boolean(result.reasoningActive)} interrupted={failed}
      durationMs={'reasoningMs' in result ? result.reasoningMs : undefined} />
    {result.text && <MarkdownAnswer key={result.attemptId ?? 'answer'} documentId={result.attemptId ?? 'answer'} text={result.text} finalized={result.status !== 'pending'} />}
    {result.status === 'succeeded' && !result.text && <p className="muted">Модель вернула пустой ответ.</p>}
    {result.status === 'pending' ? <div className="pending" role="status">
      {!result.text && !result.reasoning && !result.reasoningActive && <span className="pending-lines" aria-hidden="true"><i /><i /><i /></span>}
      Получение ответа…
    </div> : <>
      {failed && <div className="answer-error"><strong>{result.status === 'stopped' ? 'Остановлено' : result.status === 'cancelled' || result.status === 'interrupted' ? 'Прервано' : result.status === 'timed_out' ? 'Таймаут' : result.status === 'network_error' ? 'Соединение прервано' : 'Ошибка'}</strong>
        <p>{'message' in result ? result.message : result.error!.message}</p>
        {retryable && (retry ? <button type="button" disabled={disabled} onClick={retry}>Повторить ответ</button>
          : historical && <p className="muted">Повтор доступен только для последнего вопроса.</p>)}
      </div>}
      {'totalMs' in result && <AttemptMetrics result={result} totalLeader={totalLeader} firstAnswerLeader={firstAnswerLeader} costLeader={costLeader} />}
    </>}
  </>;
}
