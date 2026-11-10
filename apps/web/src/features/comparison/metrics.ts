import type { DisplayResult } from './history';

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} с`;
}

export type TimingLeaders = { total: Set<string>; firstAnswer: Set<string> };
export function timingLeaders(results: Readonly<Record<string, DisplayResult>>, settled: boolean): TimingLeaders {
  const leaders: TimingLeaders = { total: new Set(), firstAnswer: new Set() };
  const entries = Object.entries(results);
  if (!settled || entries.some(([, result]) => result.status === 'pending')) return leaders;
  const successful = entries.flatMap(([id, result]) => result.status === 'succeeded' ? [{ id, result }] : []);
  const select = (values: { id: string; value: number }[]) => {
    if (values.length < 2) return new Set<string>();
    // Comparisons use millisecond precision, independently of display rounding.
    const best = Math.min(...values.map(({ value }) => Math.round(value)));
    return new Set(values.filter(({ value }) => Math.round(value) === best).map(({ id }) => id));
  };
  leaders.total = select(successful.map(({ id, result }) => ({ id, value: result.totalMs })));
  leaders.firstAnswer = select(successful.flatMap(({ id, result }) => result.metrics?.firstAnswerMs != null
    ? [{ id, value: result.metrics.firstAnswerMs }] : []));
  return leaders;
}
