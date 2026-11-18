import type { AttemptResult } from '@llm-compare/contracts';
import { formatEstimatedCost, formatSeconds } from './metrics';

export function AttemptMetrics({ result, totalLeader, firstAnswerLeader, costLeader }: { result: AttemptResult; totalLeader: boolean; firstAnswerLeader: boolean; costLeader: boolean }) {
  const timeLabel = result.status === 'succeeded' ? 'Общее время' : result.status === 'timed_out' ? 'Таймаут через' : result.status === 'cancelled' ? 'Прервано через' : 'Ошибка через';
  const pricing = result.metrics?.costBasis?.pricing;
  const estimate = result.metrics?.cost != null ? formatEstimatedCost(result.metrics.cost) : null;
  const firstData = result.metrics?.firstEventMs != null ? formatSeconds(result.metrics.firstEventMs) : null;
  const firstAnswer = result.metrics?.firstAnswerMs != null ? formatSeconds(result.metrics.firstAnswerMs) : null;
  const pricingTitle = pricing && `Тариф из каталога в USD за 1 млн токенов. Вход: ${String(pricing.inputPerMillion).replace('.', ',')}. Выход: ${String(pricing.outputPerMillion).replace('.', ',')}.`;
  return <details className="answer-metrics">
    <summary>
      <span className="metrics-preview"><span className="answer-duration">{formatSeconds(result.totalMs)}</span>
        {estimate && <span className="answer-cost" title="Оценка стоимости">≈ {estimate}</span>}
      </span>
      <span className="metrics-toggle">Метрики<span className="metrics-chevron" aria-hidden="true" /></span>
    </summary>
    <dl>
      <div><dt title="Длительность попытки по часам сервера приложения, включая ожидание ответа сервиса моделей.">{timeLabel}</dt><dd>{formatSeconds(result.totalMs)}</dd></div>
      {firstData !== null && firstData !== firstAnswer && <div><dt title="Время до первого непустого фрагмента рассуждения, полученного сервером приложения.">Первый фрагмент Thinking</dt><dd>{firstData}</dd></div>}
      <div><dt title="До первого непустого фрагмента текста ответа, полученного сервером приложения.">Первый фрагмент ответа</dt><dd>{firstAnswer ?? 'нет данных'}</dd></div>
      <div><dt title="По данным API за эту попытку. В запрос может входить контекст беседы.">Входные токены</dt><dd>{result.metrics?.inputTokens?.toLocaleString('ru-RU') ?? 'нет данных'}</dd></div>
      <div><dt title="Итоговый счётчик выходных токенов, сообщённый API за эту попытку.">Выходные токены</dt><dd>{result.metrics?.outputTokens?.toLocaleString('ru-RU') ?? 'нет данных'}</dd></div>
      <div><dt title={pricingTitle}>Оценка стоимости</dt><dd title={pricingTitle}>{estimate ?? 'нет данных'}</dd></div>
    </dl>
    {result.metrics?.cost != null && <p className="metrics-note">По стандартному тарифу за входные и выходные токены, без скидок за кэш и специальных тарифов. Оценка относится к этой попытке.</p>}
    {(totalLeader || firstAnswerLeader || costLeader) && <ul className="timing-leaders" aria-label="Сравнение метрик">
      {totalLeader && <li title="Среди успешных ответов видимых колонок на этот вопрос. Точность сравнения — 1 мс.">Минимальное общее время</li>}
      {firstAnswerLeader && <li title="Среди успешных ответов видимых колонок с измеренным первым фрагментом. Точность сравнения — 1 мс.">Минимальное время до ответа</li>}
      {costLeader && <li title="Среди успешных ответов с оценкой по стандартному тарифу.">Наименьшая оценка стоимости</li>}
    </ul>}
    {(totalLeader || firstAnswerLeader) && <p className="metrics-note">Среди успешных ответов этого вопроса.{firstAnswerLeader && ' Для первого фрагмента сравниваются только измеренные значения.'}</p>}
  </details>;
}
