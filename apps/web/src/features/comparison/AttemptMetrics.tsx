import type { AttemptResult } from '@llm-compare/contracts';
import { formatEstimatedCost, formatSeconds } from './metrics';

export function AttemptMetrics({ result, totalLeader, firstAnswerLeader, costLeader }: { result: AttemptResult; totalLeader: boolean; firstAnswerLeader: boolean; costLeader: boolean }) {
  const timeLabel = result.status === 'succeeded' ? 'Полный ответ' : result.status === 'timed_out' ? 'Таймаут через' : result.status === 'cancelled' ? 'Прервано через' : 'Ошибка через';
  return <details className="answer-metrics">
    <summary><span className="answer-duration">{formatSeconds(result.totalMs)}</span><span>Метрики <span className="metrics-chevron" aria-hidden="true">⌄</span></span></summary>
    <dl>
      <div><dt>{timeLabel}</dt><dd>{formatSeconds(result.totalMs)}</dd></div>
      <div><dt>Первый фрагмент данных</dt><dd>{result.metrics?.firstEventMs != null ? formatSeconds(result.metrics.firstEventMs) : 'нет данных'}</dd></div>
      <div><dt>Первый фрагмент ответа</dt><dd>{result.metrics?.firstAnswerMs != null ? formatSeconds(result.metrics.firstAnswerMs) : 'нет данных'}</dd></div>
      <div><dt>Входные токены</dt><dd>{result.metrics?.inputTokens?.toLocaleString('ru-RU') ?? 'нет данных'}</dd></div>
      <div><dt>Выходные токены</dt><dd>{result.metrics?.outputTokens?.toLocaleString('ru-RU') ?? 'нет данных'}</dd></div>
      <div><dt title="Входные и выходные токены по стандартному тарифу из каталога">Оценка стоимости</dt><dd>{result.metrics?.cost != null ? formatEstimatedCost(result.metrics.cost) : 'нет данных'}</dd></div>
    </dl>
    {result.metrics?.cost != null && <p className="metrics-note">По стандартному тарифу за входные и выходные токены, без скидок за кэш и специальных тарифов. Оценка относится к этой попытке.</p>}
    {(totalLeader || firstAnswerLeader || costLeader) && <ul className="timing-leaders" aria-label="Сравнение метрик">
      {totalLeader && <li title="Среди успешных ответов видимых колонок на этот вопрос. Точность сравнения — 1 мс.">Минимальное общее время</li>}
      {firstAnswerLeader && <li title="Среди успешных ответов видимых колонок с измеренным первым фрагментом. Точность сравнения — 1 мс.">Минимальное время до ответа</li>}
      {costLeader && <li title="Среди успешных ответов с оценкой по стандартному тарифу.">Наименьшая оценка стоимости</li>}
    </ul>}
    {(totalLeader || firstAnswerLeader) && <p className="metrics-note">Среди успешных ответов этого вопроса{firstAnswerLeader ? '; первый фрагмент — среди измеренных' : ''}.</p>}
  </details>;
}
