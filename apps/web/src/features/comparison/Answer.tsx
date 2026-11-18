import { MarkdownAnswer } from '../markdown/MarkdownAnswer';
import { Thinking } from './Thinking';
import type { DisplayResult } from './history';
import { AttemptMetrics } from './AttemptMetrics';

export function Answer({ result, retry, disabled, totalLeader, firstAnswerLeader, costLeader }: { result: DisplayResult | undefined; retry: (() => void) | undefined; disabled: boolean; totalLeader: boolean; firstAnswerLeader: boolean; costLeader: boolean }) {
  if (!result) return <p className="muted">Модель добавлена после отправки вопроса. История этой колонки начинается со следующего вопроса.</p>;
  const failed = result.status !== 'succeeded' && result.status !== 'pending';
  return <>
    <Thinking text={result.reasoning ?? ''} active={result.status === 'pending' && Boolean(result.reasoningActive)} interrupted={failed}
      durationMs={'reasoningMs' in result ? result.reasoningMs : undefined} />
    {result.text && <MarkdownAnswer key={result.attemptId ?? 'answer'} documentId={result.attemptId ?? 'answer'} text={result.text} finalized={result.status !== 'pending'} />}
    {result.status === 'succeeded' && !result.text && <p className="muted">Модель вернула пустой ответ.</p>}
    {result.status === 'pending' ? <p className="pending" role="status">Получение ответа…</p> : <>
      {failed && <div className="answer-error"><strong>{result.status === 'stopped' ? 'Остановлено' : result.status === 'cancelled' || result.status === 'interrupted' ? 'Прервано' : result.status === 'timed_out' ? 'Таймаут' : result.status === 'network_error' ? 'Соединение прервано' : 'Ошибка'}</strong>
        <p>{'message' in result ? result.message : result.error!.message}</p>
        {retry && ('message' in result || result.error?.retryable) ? <button disabled={disabled} onClick={retry}>Повторить ответ</button>
          : !retry && <p className="muted">Повтор доступен только для последнего вопроса.</p>}
      </div>}
      {'totalMs' in result && <AttemptMetrics result={result} totalLeader={totalLeader} firstAnswerLeader={firstAnswerLeader} costLeader={costLeader} />}
    </>}
  </>;
}
