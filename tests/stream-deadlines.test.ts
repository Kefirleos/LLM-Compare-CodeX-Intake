import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComparisonTarget } from '@llm-compare/contracts';
import type { LlmAdapter } from '../apps/server/src/adapters/types.js';
import { streamComparison } from '../apps/server/src/generation/stream.js';
import type { OutgoingEvent } from '../apps/server/src/generation/stream.js';
import { DeadlineError, withStreamDeadline } from '../apps/server/src/generation/deadline.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
const target = (modelId = 'a'): ComparisonTarget => ({ columnId: randomUUID(), attemptId: randomUUID(), modelId, history: [] });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function run(stream: LlmAdapter['stream'], totalMs = 120_000, firstDataMs = 60_000, idleMs = 30_000, targets = [target()]) {
  const events: OutgoingEvent[] = [];
  const adapter: LlmAdapter = { mode: 'mock', listModels: async () => [], generate: async () => ({ text: 'unused' }), ...(stream ? { stream } : {}) };
  const done = streamComparison(adapter, 'Вопрос', targets, new AbortController().signal, totalMs, async (event) => { events.push(event); }, { firstDataMs, idleMs });
  return { events, done, adapter };
}
const results = (events: OutgoingEvent[]) => events.filter((event) => event.type === 'model_result').map((event) => event.result);

it('does not treat empty deltas as first data and isolates a silent model', async () => {
  const signals: AbortSignal[] = [];
  const { events, done } = run(async function* ({ modelId }, signal) {
    signals.push(signal);
    if (modelId === 'b') { yield 'готово'; return; }
    while (!signal.aborted) { yield ''; await wait(10_000); }
  }, 120_000, 60_000, 30_000, [target(), target('b')]);
  await vi.advanceTimersByTimeAsync(60_000);
  await done;
  expect(results(events).map((item) => [item.status, item.text])).toEqual([['succeeded', 'готово'], ['timed_out', '']]);
  expect(results(events)[1]!.error?.message).toContain('не начала');
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
});

it('uses the idle budget after content and retains partial text', async () => {
  const { events, done } = run(async function* (_input, signal) {
    yield 'часть 👋';
    while (!signal.aborted) { await wait(10_000); yield ''; }
  });
  await vi.advanceTimersByTimeAsync(30_000);
  await done;
  expect(results(events)[0]).toMatchObject({ status: 'timed_out', text: 'часть 👋', error: { message: 'Модель слишком долго не присылает данные.' } });
});

it('counts reasoning as activity without adding it to the answer', async () => {
  const { events, done } = run(async function* (_input, _signal, activity) {
    for (let i = 0; i < 5; i++) { await wait(20_000); activity?.(); }
    yield 'Ответ';
  });
  await vi.advanceTimersByTimeAsync(100_000);
  await done;
  expect(results(events)[0]).toMatchObject({ status: 'succeeded', text: 'Ответ' });
});

it('enforces total time even with continuous activity', async () => {
  const { events, done } = run(async function* (_input, signal, activity) {
    while (!signal.aborted) { await wait(10_000); activity?.(); }
  });
  await vi.advanceTimersByTimeAsync(120_000);
  await done;
  expect(results(events)[0]).toMatchObject({ status: 'timed_out', error: { message: 'Превышено общее время ответа модели.' } });
});

it('does not apply streaming activity timers to a non-streaming adapter', async () => {
  const events: OutgoingEvent[] = [];
  const adapter: LlmAdapter = { mode: 'mock', listModels: async () => [], generate: async () => { await wait(25_000); return { text: 'Готово' }; } };
  const done = streamComparison(adapter, 'Вопрос', [target()], new AbortController().signal, 120_000,
    async (event) => { events.push(event); }, { firstDataMs: 15_000, idleMs: 10_000 });
  await vi.advanceTimersByTimeAsync(25_000);
  await done;
  expect(results(events)[0]).toMatchObject({ status: 'succeeded', text: 'Готово' });
});

it('pauses inactivity while a local write blocks, then grants a fresh idle budget', async () => {
  const events: OutgoingEvent[] = [];
  const adapter: LlmAdapter = { mode: 'mock', listModels: async () => [], generate: async () => ({ text: '' }), stream: async function* () {
    yield 'первая'; await wait(29_000); yield ' вторая';
  } };
  const done = streamComparison(adapter, 'Вопрос', [target()], new AbortController().signal, 120_000, async (event) => {
    events.push(event);
    if (event.type === 'answer_delta' && event.text === 'первая') await wait(40_000);
  });
  await vi.advanceTimersByTimeAsync(69_000);
  await done;
  expect(results(events)[0]).toMatchObject({ status: 'succeeded', text: 'первая вторая' });
});

it('keeps total timeout active during a local pause and ignores late activity', async () => {
  const done = withStreamDeadline(async (_signal, clock) => {
    clock.pause(); await wait(130_000); clock.resume(); clock.activity();
  }, new AbortController().signal, 120_000, { firstDataMs: 60_000, idleMs: 30_000 }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await done).toEqual(new DeadlineError('total'));
  await vi.advanceTimersByTimeAsync(10_000);
});

it('removes timers and the parent abort listener after repeated completions', async () => {
  const parent = new AbortController();
  const add = vi.spyOn(parent.signal, 'addEventListener');
  const remove = vi.spyOn(parent.signal, 'removeEventListener');
  for (let i = 0; i < 50; i++) await withStreamDeadline(async (_signal, clock) => { clock.activity(); }, parent.signal, 120_000, { firstDataMs: 60_000, idleMs: 30_000 });
  expect(add).toHaveBeenCalledTimes(50);
  expect(remove).toHaveBeenCalledTimes(50);
});

it('preserves all fragments across four streams with unfinished Markdown', async () => {
  const text = '```text\n' + 'я 👋 [незакрытая ссылка '.repeat(2048);
  const targets = ['a', 'b', 'c', 'd'].map(target);
  const { events, done } = run(async function* () {
    for (let offset = 0; offset < text.length; offset += 64) yield text.slice(offset, offset + 64);
  }, 120_000, 60_000, 30_000, targets);
  await done;
  expect(results(events)).toHaveLength(4);
  for (const result of results(events)) {
    expect(result.status).toBe('succeeded');
    expect(result.text).toBe(text);
    expect(events.filter((event) => event.type === 'answer_delta' && event.columnId === result.columnId).map((event) => event.type === 'answer_delta' ? event.text : '').join('')).toBe(text);
  }
});

it('enforces the UTF-8 output limit independently and keeps the last valid fragment', async () => {
  const partial = 'я'.repeat(256 * 1024);
  const { events, done } = run(async function* ({ modelId }) {
    if (modelId === 'b') { yield 'готово'; return; }
    yield partial; yield 'x';
  }, 120_000, 60_000, 30_000, [target(), target('b')]);
  await done;
  expect(results(events).find((result) => result.modelId === 'a')).toMatchObject({ status: 'failed', text: partial, error: { code: 'OUTPUT_LIMIT' } });
  expect(results(events).find((result) => result.modelId === 'b')).toMatchObject({ status: 'succeeded', text: 'готово' });
});
