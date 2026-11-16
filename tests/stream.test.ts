import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_NDJSON_STREAM_BYTES, decodeNdjson, streamEventSchema } from '@llm-compare/contracts';
import type { ComparisonRequest, StreamEvent } from '@llm-compare/contracts';
import { buildApp } from '../apps/server/src/app.js';
import { FakeAdapter } from '../apps/server/src/adapters/fake.js';
import { sendComparison } from '../apps/web/src/api/comparisons';
import { CodexProxyAdapter } from '../apps/server/src/adapters/codex-proxy.js';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(apps.splice(0).map((app) => app.close())); });
function input(): ComparisonRequest {
  return { protocolVersion: 1, conversationId: randomUUID(), runId: randomUUID(), turnId: randomUUID(), prompt: 'Привет 👋',
    targets: ['mock-clear', 'mock-detailed'].map((modelId) => ({ modelId, columnId: randomUUID(), attemptId: randomUUID(), history: [] })) };
}
function bytes(text: string, step = 1) {
  const data = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < data.length; offset += step) controller.enqueue(data.slice(offset, offset + step));
    controller.close();
  } });
}
it('decodes split UTF-8, CRLF, blank lines and a final record without LF', async () => {
  const values = [];
  for await (const value of decodeNdjson(bytes('\ufeff\r\n{"text":"Привет 👋\\n"}\r\n{"n":2}'), new AbortController().signal)) values.push(value);
  expect(values).toEqual([{ text: 'Привет 👋\n' }, { n: 2 }]);
});
it('rejects truncated JSON and invalid UTF-8', async () => {
  const collect = async (body: ReadableStream<Uint8Array>) => { for await (const _ of decodeNdjson(body, new AbortController().signal)) { /* consume */ } };
  await expect(collect(bytes('{"text":'))).rejects.toThrow();
  await expect(collect(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0xff])); c.close(); } }))).rejects.toThrow();
  await expect(collect(bytes('{}\n\ufeff{}'))).rejects.toThrow();
});
it('rejects a stream that grows past the line limit without a newline', async () => {
  const consume = async () => {
    for await (const _ of decodeNdjson(bytes('x'.repeat(4 * 1024 * 1024 + 1), 64 * 1024), new AbortController().signal)) { /* consume */ }
  };
  await expect(consume()).rejects.toThrow('Строка потока слишком велика');
});
it('decodes a fragmented line at the byte limit and counts only the leading BOM outside that limit', async () => {
  const lineLimit = 4 * 1024 * 1024;
  const value = 'я'.repeat(lineLimit / 2 - 1);
  const signal = new AbortController().signal;
  const reader = decodeNdjson(bytes('\ufeff"' + value + '"\nnull', 1024), signal);
  expect(await reader.next()).toEqual({ value, done: false });
  expect(await reader.next()).toEqual({ value: null, done: false });
  expect((await reader.next()).done).toBe(true);
  const pastLimit = decodeNdjson(bytes('"' + value + 'x"\n', lineLimit + 2), signal);
  await expect(pastLimit.next()).rejects.toThrow('Строка потока слишком велика');
});

it('stops before delivering another buffered record after cancellation', async () => {
  const controller = new AbortController();
  const reader = decodeNdjson(bytes('1\n2\n', 16), controller.signal);
  expect(await reader.next()).toEqual({ value: 1, done: false });
  controller.abort();
  await expect(reader.next()).rejects.toMatchObject({ name: 'AbortError' });
});

it('releases the reader at an explicit terminal even while underlying cancellation is pending', async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('1\n')); },
    cancel,
  });
  const reader = decodeNdjson(body, new AbortController().signal);
  expect(await reader.next()).toEqual({ value: 1, done: false });
  expect((await reader.return(undefined)).done).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

it('cancels a blocked reader immediately on abort', async () => {
  const cancel = vi.fn();
  const controller = new AbortController();
  const iterator = decodeNdjson(new ReadableStream({ cancel }), controller.signal);
  const next = iterator.next();
  controller.abort();
  await expect(next).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
});

it('flushes real HTTP deltas before completion and aborts upstream on disconnect', async () => {
  const adapter = new FakeAdapter();
  let cancelled = 0;
  adapter.stream = async function* (_input, signal) {
    try { yield 'часть 👋'; await delay(60_000, undefined, { signal }); yield 'конец'; }
    finally { cancelled++; }
  };
  const app = buildApp(adapter);
  apps.push(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${address}/api/comparisons`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify(input()), signal: controller.signal });
  const events: StreamEvent[] = [];
  for await (const raw of decodeNdjson(response.body!, controller.signal)) {
    const event = streamEventSchema.parse(raw);
    events.push(event);
    if (event.type === 'answer_delta') break;
  }
  controller.abort();
  expect(events.some((event) => event.type === 'run_completed')).toBe(false);
  await vi.waitFor(() => expect(cancelled).toBe(2));
});

it('streams independent terminals, retaining partial text on timeout', async () => {
  const adapter = new FakeAdapter();
  adapter.stream = async function* ({ modelId }, signal) {
    yield modelId;
    if (modelId === 'mock-detailed') await delay(60_000, undefined, { signal });
  };
  const app = buildApp(adapter, { attemptTimeoutMs: 40 });
  apps.push(app);
  const response = await app.inject({ method: 'POST', url: '/api/comparisons', headers: { accept: 'application/x-ndjson' }, payload: input() });
  const events = response.body.trim().split('\n').map((line) => streamEventSchema.parse(JSON.parse(line)));
  expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => i + 1));
  const results = events.filter((event) => event.type === 'model_result').map((event) => event.result);
  expect(results.map((result) => result.status)).toEqual(['succeeded', 'timed_out']);
  expect(results[1]!.text).toBe('mock-detailed');
  expect(events.at(-1)!.type).toBe('run_completed');
});

it('aborts active streaming attempts when the server closes', async () => {
  const adapter = new FakeAdapter();
  const signals: AbortSignal[] = [];
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  adapter.stream = async function* (_input, signal) {
    signals.push(signal);
    if (signals.length === 2) ready();
    yield 'часть';
    await delay(60_000, undefined, { signal });
  };
  const app = buildApp(adapter);
  apps.push(app);
  const pending = app.inject({ method: 'POST', url: '/api/comparisons', headers: { accept: 'application/x-ndjson' }, payload: input() }).then((response) => response);
  await started;
  await app.close();
  const response = await pending;
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(response.body).not.toContain('run_completed');
});

it('aborts non-streaming requests even when the adapter ignores shutdown', async () => {
  const adapter = new FakeAdapter();
  const signals: AbortSignal[] = [];
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  vi.spyOn(adapter, 'generate').mockImplementation(async (_input, signal) => {
    signals.push(signal);
    if (signals.length === 2) ready();
    return new Promise(() => {});
  });
  const app = buildApp(adapter);
  apps.push(app);
  const pending = app.inject({ method: 'POST', url: '/api/comparisons', payload: input() }).then((response) => response);
  await started;
  await app.close();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect((await pending).json().results.map((result: { status: string }) => result.status)).toEqual(['cancelled', 'cancelled']);
});

it('waits for downstream drain before advancing producers', async () => {
  const adapter = new FakeAdapter();
  const stream = vi.spyOn(adapter, 'stream');
  const app = buildApp(adapter);
  apps.push(app);
  let resume: (() => void) | undefined;
  app.addHook('onRequest', async (_request, reply) => {
    const write = reply.raw.write.bind(reply.raw);
    let first = true;
    reply.raw.write = ((...args: Parameters<typeof reply.raw.write>) => {
      const result = write(...args);
      if (!first) return result;
      first = false;
      resume = () => reply.raw.emit('drain');
      return false;
    }) as typeof reply.raw.write;
  });
  const pending = app.inject({ method: 'POST', url: '/api/comparisons', headers: { accept: 'application/x-ndjson' }, payload: input() }).then((response) => response);
  await vi.waitFor(() => expect(resume).toBeDefined());
  expect(stream).not.toHaveBeenCalled();
  resume!();
  expect((await pending).body).toContain('run_completed');
});

it('closes a stalled downstream and releases reserved capacity', async () => {
  const adapter = new FakeAdapter();
  const stream = vi.spyOn(adapter, 'stream');
  vi.spyOn(adapter, 'generate').mockResolvedValue({ text: 'готово' });
  const app = buildApp(adapter);
  apps.push(app);
  const forcedClose = vi.fn();
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.accept !== 'application/x-ndjson') return;
    reply.raw.write = (() => false) as typeof reply.raw.write;
    reply.raw.once('close', () => forcedClose(reply.raw.destroyed, reply.raw.writableEnded));
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const responses = await Promise.all([0, 1].map(() => {
    const payload = input();
    for (const modelId of ['mock-slow', 'mock-error']) payload.targets.push({ modelId, columnId: randomUUID(), attemptId: randomUUID(), history: [] });
    return fetch(`${address}/api/comparisons`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
    });
  }));
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect((await app.inject({ method: 'POST', url: '/api/comparisons', payload: input() })).statusCode).toBe(429);
  await Promise.all(responses.map((response) => expect(response.text()).rejects.toMatchObject({ name: 'TypeError' })));
  await vi.waitFor(() => expect(forcedClose.mock.calls).toEqual([[true, false], [true, false]]));
  expect(stream).not.toHaveBeenCalled();
  expect((await app.inject({ method: 'POST', url: '/api/comparisons', payload: input() })).statusCode).toBe(200);
}, 10_000);

it('keeps the received tail and other models when one stream exhausts its frame budget', async () => {
  const adapter = new FakeAdapter();
  const fragmentedLength = 128 * 1024;
  // Escapes make the terminal much larger than the underlying UTF-8 text.
  const escaped = '\0'.repeat(512 * 1024);
  adapter.stream = async function* ({ modelId }) {
    if (modelId === 'mock-clear') {
      for (let index = 0; index < fragmentedLength; index++) yield 'x';
    } else if (modelId === 'mock-detailed') {
      yield escaped;
    } else {
      yield { type: 'reasoning_delta', text: 'план' };
      yield 'готово';
    }
  };
  const payload = input();
  for (const modelId of ['mock-slow', 'mock-error']) payload.targets.push({ modelId, columnId: randomUUID(), attemptId: randomUUID(), history: [] });
  const app = buildApp(adapter);
  apps.push(app);
  const wire = await app.inject({ method: 'POST', url: '/api/comparisons', headers: { accept: 'application/x-ndjson' }, payload });
  expect(Buffer.byteLength(wire.body)).toBeLessThanOrEqual(MAX_NDJSON_STREAM_BYTES);

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(wire.body, { headers: { 'content-type': 'application/x-ndjson' } })));
  let lastType: StreamEvent['type'] | undefined;
  const response = await sendComparison(payload, new AbortController().signal, (event) => { lastType = event.type; });
  expect(lastType).toBe('run_completed');
  const limited = response.results.find((result) => result.modelId === 'mock-clear')!;
  expect(limited).toMatchObject({ status: 'failed', error: { code: 'OUTPUT_LIMIT', retryable: false } });
  expect(limited.text.length).toBeGreaterThan(0);
  expect(limited.text.length).toBeLessThan(fragmentedLength);
  expect(limited.text).toBe('x'.repeat(limited.text.length));
  expect(response.results.find((result) => result.modelId === 'mock-detailed')).toMatchObject({ status: 'succeeded', text: escaped });
  for (const modelId of ['mock-slow', 'mock-error']) {
    expect(response.results.find((result) => result.modelId === modelId)).toMatchObject({ status: 'succeeded', reasoning: 'план', text: 'готово' });
  }
}, 15_000);

function streamFixture(body: ComparisonRequest) {
  let seq = 0;
  const base = { v: 1 as const, runId: body.runId, turnId: body.turnId };
  const events: StreamEvent[] = [{ ...base, seq: ++seq, type: 'run_started' }];
  for (const target of body.targets) {
    const { columnId, attemptId, modelId } = target;
    const identity = { columnId, attemptId, modelId };
    events.push({ ...base, seq: ++seq, type: 'model_started', ...identity },
      { ...base, seq: ++seq, type: 'answer_delta', ...identity, text: modelId },
      { ...base, seq: ++seq, type: 'model_result', result: { ...identity, text: modelId, totalMs: 20, status: 'succeeded', error: null } });
  }
  events.push({ ...base, seq: ++seq, type: 'run_completed' });
  return events;
}

it.each(['valid', 'mismatch', 'wrong attempt', 'missing start'] as const)('validates Thinking in the client stream: %s', async (scenario) => {
  const body = input();
  const events = streamFixture(body);
  const first = body.targets[0]!;
  const common = { v: 1 as const, runId: body.runId, turnId: body.turnId, columnId: first.columnId, attemptId: first.attemptId, modelId: first.modelId, seq: 0 };
  events.splice(2, 0, { ...common, type: 'reasoning_started' }, { ...common, type: 'reasoning_delta', text: 'мысль' }, { ...common, type: 'reasoning_ended' });
  const terminal = events.find((event) => event.type === 'model_result');
  if (terminal?.type === 'model_result') terminal.result.reasoning = scenario === 'mismatch' ? 'подмена' : 'мысль';
  if (scenario === 'wrong attempt') Object.assign(events[3]!, { attemptId: randomUUID() });
  if (scenario === 'missing start') events.splice(2, 1);
  events.forEach((event, i) => { event.seq = i + 1; });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes(events.map((event) => JSON.stringify(event)).join('\n'), 7), { headers: { 'content-type': 'application/x-ndjson' } })));
  const promise = sendComparison(body, new AbortController().signal, vi.fn());
  if (scenario === 'valid') expect((await promise).results[0]!.reasoning).toBe('мысль');
  else await expect(promise).rejects.toThrow();
});

it.each(['finish', 'truncated', 'text-end', 'error', 'unknown', 'invalid delta'] as const)('normalizes proxy stream: %s', async (scenario) => {
  const events: unknown[] = [{ type: 'start' }, { type: 'reasoning-delta', delta: '' }, { type: 'reasoning-delta', delta: 'private reasoning' }, { type: 'text-delta', delta: 'Ответ 👋' }];
  if (scenario === 'finish') events.push({ type: 'text-end' }, { type: 'finish' });
  if (scenario === 'text-end') events.push({ type: 'text-end' });
  if (scenario === 'error') events.push({ type: 'error', message: 'private provider detail' });
  if (scenario === 'unknown') events.push({ type: 'surprise' });
  if (scenario === 'invalid delta') events.push({ type: 'text-delta', delta: 42 });
  const transport = vi.fn<typeof fetch>(async () => new Response(bytes(events.map((event) => JSON.stringify(event)).join('\n')), { headers: { 'content-type': 'application/x-ndjson' } }));
  const adapter = new CodexProxyAdapter('fixture-key', transport);
  const received: unknown[] = [];
  const activity = vi.fn();
  const consume = async () => { for await (const delta of adapter.stream({ modelId: 'openai/test', prompt: 'Вопрос' }, new AbortController().signal, activity)) received.push(delta); };
  if (scenario === 'finish') await consume();
  else await expect(consume()).rejects.toMatchObject({ publicError: { code: scenario === 'error' ? 'GENERATION_FAILED' : 'UPSTREAM_PROTOCOL' } });
  expect(received.filter((chunk) => typeof chunk === 'string')).toEqual(['Ответ 👋']);
  expect(received).toContainEqual({ type: 'reasoning_delta', text: 'private reasoning' });
  expect(activity).toHaveBeenCalledTimes(2);
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]![0]).toBe('https://llm.codex.so/stream');
  const options = transport.mock.calls[0]![1]!;
  expect(new Headers(options.headers).get('accept')).toBe('application/x-ndjson');
  expect(options.body).toBe(JSON.stringify({ prompt: 'Вопрос', model: 'openai/test' }));
  expect(options.redirect).toBe('error');
});
it.each(['valid', 'duplicate', 'gap', 'truncated', 'wrong attempt', 'wrong text'] as const)('validates client stream: %s', async (scenario) => {
  const body = input();
  const events = streamFixture(body);
  if (scenario === 'duplicate') events.splice(2, 0, events[1]!);
  if (scenario === 'gap') events.splice(2, 1);
  if (scenario === 'truncated') events.pop();
  if (scenario === 'wrong attempt') Object.assign(events[2]!, { attemptId: randomUUID() });
  if (scenario === 'wrong text' && events[3]!.type === 'model_result') events[3]!.result.text = 'wrong';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes(events.map((event) => JSON.stringify(event)).join('\n'), 7), { headers: { 'content-type': 'application/x-ndjson' } })));
  const update = vi.fn();
  const promise = sendComparison(body, new AbortController().signal, update);
  if (scenario === 'valid' || scenario === 'duplicate') {
    expect((await promise).results).toHaveLength(2);
    expect(update).toHaveBeenCalledTimes(8);
  } else await expect(promise).rejects.toThrow();
});
