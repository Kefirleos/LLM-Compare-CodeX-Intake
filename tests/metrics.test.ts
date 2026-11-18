import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { attemptResultSchema } from '@llm-compare/contracts';
import type { AttemptMetrics, AttemptResult } from '@llm-compare/contracts';
import { comparisonLeaders, formatSeconds } from '../apps/web/src/features/comparison/metrics';
import type { DisplayResult } from '../apps/web/src/features/comparison/history';
import { streamComparison } from '../apps/server/src/generation/stream.js';
import type { OutgoingEvent } from '../apps/server/src/generation/stream.js';
import { runComparison } from '../apps/server/src/generation/runner.js';
import type { LlmAdapter } from '../apps/server/src/adapters/types.js';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const metrics = (first: number | null = null, answer: number | null = null): AttemptMetrics => ({ firstEventMs: first, firstAnswerMs: answer, inputTokens: null, outputTokens: null, cost: null });
function success(totalMs: number, first: number | null = null): AttemptResult {
  return { columnId: randomUUID(), attemptId: randomUUID(), modelId: 'a', status: 'succeeded', text: 'ok', error: null, totalMs, metrics: metrics(first, first) };
}
const target = () => ({ columnId: randomUUID(), attemptId: randomUUID(), modelId: 'a', history: [] });
afterEach(() => vi.useRealTimers());

it('measures real content/reasoning arrival from upstream start, excluding initial downstream wait', async () => {
  vi.useFakeTimers();
  const adapter: LlmAdapter = { mode: 'mock', listModels: async () => [], generate: async () => ({ text: '' }), stream: async function* () {
    yield ''; yield { type: 'reasoning_started' };
    await wait(100); yield { type: 'reasoning_delta', text: 'мысль' };
    await wait(100); yield 'ответ';
    await wait(300);
  } };
  const events: OutgoingEvent[] = [];
  const done = streamComparison(adapter, 'Q', [target()], new AbortController().signal, 1000, async (event) => {
    events.push(event);
    if (event.type === 'model_started') await wait(50);
  });
  await vi.advanceTimersByTimeAsync(550);
  await done;
  const terminal = events.find((event) => event.type === 'model_result');
  expect(terminal?.type === 'model_result' && terminal.result).toMatchObject({ totalMs: 500, reasoningMs: 200, metrics: metrics(100, 200) });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['json', 'stream transport'] as const)('does not manufacture first-fragment timing for nonstream generation: %s', async (mode) => {
  vi.useFakeTimers();
  const adapter: LlmAdapter = { mode: 'mock', listModels: async () => [], generate: async () => { await wait(25_000); return { text: 'готово' }; } };
  const events: OutgoingEvent[] = [];
  const done = mode === 'json' ? runComparison(adapter, 'Q', [target()], new AbortController().signal, 120_000)
    : streamComparison(adapter, 'Q', [target()], new AbortController().signal, 120_000, async (event) => { events.push(event); });
  await vi.advanceTimersByTimeAsync(25_000);
  const json = await done;
  const terminal = events.find((event) => event.type === 'model_result');
  const result = Array.isArray(json) ? json[0] : terminal?.type === 'model_result' ? terminal.result : undefined;
  expect(result).toMatchObject({ totalMs: 25_000, metrics: metrics() });
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps an unobserved first fragment null on timeout', async () => {
  vi.useFakeTimers();
  const adapter: LlmAdapter = { mode: 'mock', listModels: async () => [], generate: async () => ({ text: '' }), stream: async function* () { yield ''; await new Promise(() => {}); } };
  const events: OutgoingEvent[] = [];
  const done = streamComparison(adapter, 'Q', [target()], new AbortController().signal, 1000, async (event) => { events.push(event); }, { firstDataMs: 100, idleMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  await done;
  const terminal = events.find((event) => event.type === 'model_result');
  expect(terminal?.type === 'model_result' && terminal.result).toMatchObject({ status: 'timed_out', totalMs: 100, metrics: metrics() });
});

it('waits for final usage without counting it as an answer or a reasoning phase', async () => {
  vi.useFakeTimers();
  const adapter: LlmAdapter = { mode: 'mock', listModels: async () => [], generate: async () => ({ text: '' }), stream: async function* () {
    await wait(10);
    yield 'answer';
    await wait(150);
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 2 } };
  } };
  const events: OutgoingEvent[] = [];
  const done = streamComparison(adapter, 'Q', [target()], new AbortController().signal, 1000, async (event) => { events.push(event); });
  await vi.advanceTimersByTimeAsync(160);
  await done;
  const terminal = events.find((event) => event.type === 'model_result');
  expect(terminal?.type === 'model_result' && terminal.result).toMatchObject({
    totalMs: 160, metrics: { firstEventMs: 10, firstAnswerMs: 10, inputTokens: 0, outputTokens: 2, cost: null },
  });
  expect(events.filter((event) => event.type.startsWith('reasoning_'))).toHaveLength(0);
});

it('never ranks failures or unfinished runs, and requires two comparable successes', () => {
  const failed: AttemptResult = { ...success(1), status: 'failed', error: { code: 'GENERATION_FAILED', message: 'error', retryable: true } };
  const results: Record<string, DisplayResult> = { failed, a: success(2000, 200), b: success(3000, 100) };
  expect([...comparisonLeaders(results, true).total]).toEqual(['a']);
  expect([...comparisonLeaders(results, true).firstAnswer]).toEqual(['b']);
  expect(comparisonLeaders(results, false).total.size).toBe(0);
  expect(comparisonLeaders({ ...results, pending: { status: 'pending' } }, true).total.size).toBe(0);
  expect(comparisonLeaders({ failed, a: success(2000) }, true).total.size).toBe(0);
  expect(comparisonLeaders({ a: success(2000, 0), b: success(3000) }, true).firstAnswer.size).toBe(0);
});

it('uses millisecond precision for ties, independently of rounded display values', () => {
  expect([...comparisonLeaders({ a: success(1000.1), b: success(1000.4) }, true).total]).toEqual(['a', 'b']);
  expect(formatSeconds(1001.1)).toBe(formatSeconds(1004.4));
  expect([...comparisonLeaders({ a: success(1001.1), b: success(1004.4) }, true).total]).toEqual(['a']);
});

it('distinguishes a measured fraction of a centisecond from zero', () => {
  expect(formatSeconds(0)).toBe('0 с');
  expect(formatSeconds(1)).toBe('<0,01 с');
  expect(formatSeconds(10)).toBe('0,01 с');
});

it('recalculates leaders from the selected retry without using older attempts', () => {
  expect([...comparisonLeaders({ a: success(2000, 200), b: success(3000, 300) }, true).total]).toEqual(['a']);
  expect([...comparisonLeaders({ a: success(2000, 200), b: success(1000, 100) }, true).total]).toEqual(['b']);
});

it.each(['fractional tokens', 'cost without counts', 'negative cost', 'answer before data', 'fragment after completion', 'negative time'] as const)('rejects invalid metrics: %s', (scenario) => {
  const result = success(1000, 100);
  if (scenario === 'fractional tokens') Object.assign(result.metrics!, { inputTokens: 0.5 });
  if (scenario === 'cost without counts') Object.assign(result.metrics!, { cost: 0 });
  if (scenario === 'negative cost') Object.assign(result.metrics!, { inputTokens: 0, outputTokens: 0, cost: -1 });
  if (scenario === 'answer before data') Object.assign(result.metrics!, { firstEventMs: 200 });
  if (scenario === 'fragment after completion') Object.assign(result.metrics!, { firstEventMs: 1100, firstAnswerMs: 1100 });
  if (scenario === 'negative time') Object.assign(result.metrics!, { firstAnswerMs: -1 });
  expect(attemptResultSchema.safeParse(result).success).toBe(false);
});
