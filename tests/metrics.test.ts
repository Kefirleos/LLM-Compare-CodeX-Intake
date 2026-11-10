import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { attemptResultSchema } from '@llm-compare/contracts';
import type { AttemptMetrics, AttemptResult } from '@llm-compare/contracts';
import { timingLeaders, formatSeconds } from '../apps/web/src/features/comparison/metrics';
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
  expect(terminal?.type === 'model_result' && terminal.result).toMatchObject({ totalMs: 500, metrics: metrics(100, 200) });
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

it('never ranks failures or unfinished runs, and requires two comparable successes', () => {
  const failed: AttemptResult = { ...success(1), status: 'failed', error: { code: 'GENERATION_FAILED', message: 'error', retryable: true } };
  const results: Record<string, DisplayResult> = { failed, a: success(2000, 200), b: success(3000, 100) };
  expect([...timingLeaders(results, true).total]).toEqual(['a']);
  expect([...timingLeaders(results, true).firstAnswer]).toEqual(['b']);
  expect(timingLeaders(results, false).total.size).toBe(0);
  expect(timingLeaders({ ...results, pending: { status: 'pending' } }, true).total.size).toBe(0);
  expect(timingLeaders({ failed, a: success(2000) }, true).total.size).toBe(0);
  expect(timingLeaders({ a: success(2000, 0), b: success(3000) }, true).firstAnswer.size).toBe(0);
});

it('uses millisecond precision for ties, independently of rounded display values', () => {
  expect([...timingLeaders({ a: success(1000.1), b: success(1000.4) }, true).total]).toEqual(['a', 'b']);
  expect(formatSeconds(1001.1)).toBe(formatSeconds(1004.4));
  expect([...timingLeaders({ a: success(1001.1), b: success(1004.4) }, true).total]).toEqual(['a']);
});

it('recalculates leaders from the selected retry without using older attempts', () => {
  expect([...timingLeaders({ a: success(2000, 200), b: success(3000, 300) }, true).total]).toEqual(['a']);
  expect([...timingLeaders({ a: success(2000, 200), b: success(1000, 100) }, true).total]).toEqual(['b']);
});

it.each(['fabricated tokens', 'fabricated cost', 'answer before data', 'fragment after completion', 'negative time'] as const)('rejects invalid metrics: %s', (scenario) => {
  const result = success(1000, 100);
  if (scenario === 'fabricated tokens') Object.assign(result.metrics!, { inputTokens: 0 });
  if (scenario === 'fabricated cost') Object.assign(result.metrics!, { cost: 0 });
  if (scenario === 'answer before data') Object.assign(result.metrics!, { firstEventMs: 200 });
  if (scenario === 'fragment after completion') Object.assign(result.metrics!, { firstEventMs: 1100, firstAnswerMs: 1100 });
  if (scenario === 'negative time') Object.assign(result.metrics!, { firstAnswerMs: -1 });
  expect(attemptResultSchema.safeParse(result).success).toBe(false);
});
