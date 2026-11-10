import type { AttemptResult } from '@llm-compare/contracts';
import { formatSeconds } from './metrics';

export function AttemptMetrics({ result, totalLeader, firstAnswerLeader }: { result: AttemptResult; totalLeader: boolean; firstAnswerLeader: boolean }) {
  const timeLabel = result.status === 'succeeded' ? 'Полный ответ' : result.status === 'timed_out' ? 'Таймаут через' : result.status === 'cancelled' ? 'Прервано через' : 'Ошибка через';
  return <div className="answer-metrics" aria-label="Метрики попытки">
    <dl>
      <div><dt>{timeLabel}</dt><dd>{formatSeconds(result.totalMs)}</dd></div>
      <div><dt>Первый фрагмент данных</dt><dd>{result.metrics?.firstEventMs != null ? formatSeconds(result.metrics.firstEventMs) : 'нет данных'}</dd></div>
      <div><dt>Первый фрагмент ответа</dt><dd>{result.metrics?.firstAnswerMs != null ? formatSeconds(result.metrics.firstAnswerMs) : 'нет данных'}</dd></div>
      <div><dt>Входные токены</dt><dd>нет данных</dd></div>
      <div><dt>Выходные токены</dt><dd>нет данных</dd></div>
      <div><dt>Стоимость</dt><dd>нет данных</dd></div>
    </dl>
    {(totalLeader || firstAnswerLeader) && <ul className="timing-leaders" aria-label="Сравнение времени">
      {totalLeader && <li title="Среди успешных ответов видимых колонок на этот вопрос. Точность сравнения — 1 мс.">Минимальное общее время</li>}
      {firstAnswerLeader && <li title="Среди успешных ответов видимых колонок с измеренным первым фрагментом. Точность сравнения — 1 мс.">Минимальное время до ответа</li>}
    </ul>}
    {(totalLeader || firstAnswerLeader) && <p className="metrics-note">Среди успешных ответов этого вопроса{firstAnswerLeader ? '; первый фрагмент — среди измеренных' : ''}.</p>}
  </div>;
}
