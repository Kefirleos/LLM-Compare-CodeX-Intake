import type { DisplayResult } from './history';

export function formatSeconds(ms: number): string {
  if (ms > 0 && ms < 10) return '<0,01 с';
  return `${(ms / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} с`;
}

export function formatEstimatedCost(usd: number): string {
  return usd.toLocaleString('ru-RU', { maximumSignificantDigits: 4, useGrouping: false }) + ' USD';
}

export function comparisonLeaders(results: Readonly<Record<string, DisplayResult>>, settled: boolean) {
  const leaders = { total: new Set<string>(), firstAnswer: new Set<string>(), cost: new Set<string>() };
  const entries = Object.entries(results);
  if (!settled || entries.some(([, result]) => result.status === 'pending')) return leaders;
  const successful = entries.flatMap(([id, result]) => result.status === 'succeeded' ? [{ id, result }] : []);
  const select = (values: { id: string; value: number }[], compareValue: (value: number) => number) => {
    if (values.length < 2) return new Set<string>();
    const best = Math.min(...values.map(({ value }) => compareValue(value)));
    return new Set(values.filter(({ value }) => compareValue(value) === best).map(({ id }) => id));
  };
  // Time comparisons use milliseconds. Cost estimates use their stored values.
  leaders.total = select(successful.map(({ id, result }) => ({ id, value: result.totalMs })), Math.round);
  leaders.firstAnswer = select(successful.flatMap(({ id, result }) => result.metrics?.firstAnswerMs != null
    ? [{ id, value: result.metrics.firstAnswerMs }] : []), Math.round);
  leaders.cost = select(successful.flatMap(({ id, result }) => result.metrics?.cost != null
    ? [{ id, value: result.metrics.cost }] : []), (value) => value);
  return leaders;
}
