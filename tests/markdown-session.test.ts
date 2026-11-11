import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownEngine } from '../apps/web/src/features/markdown/engine';
import type { AstBlock } from '../apps/web/src/features/markdown/engine';
import { MarkdownSession } from '../apps/web/src/features/markdown/session';
import type { AstPatch, ParseRequest, ParserPort, WorkerReply } from '../apps/web/src/features/markdown/session';

afterEach(() => vi.useRealTimers());
class FakeWorker implements ParserPort {
  onmessage: ParserPort['onmessage'] = null;
  onerror: ParserPort['onerror'] = null;
  requests: ParseRequest[] = [];
  terminated = false;
  active = 0;
  maxActive = 0;
  private engine = new MarkdownEngine();
  private blocks = new Map<string, AstBlock>();
  constructor(private readonly latency = 100) {}
  postMessage(request: ParseRequest) {
    this.requests.push(request); this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    setTimeout(() => {
      this.active--;
      if (this.terminated) return;
      const result = this.engine.update(request.text);
      const patch: AstPatch = { ...request, changed: result.blocks.filter((block) => this.blocks.get(block.id) !== block), order: result.blocks.map((block) => block.id), stats: result.stats };
      this.blocks = new Map(result.blocks.map((block) => [block.id, block]));
      this.deliver(structuredClone(patch));
    }, this.latency);
  }
  deliver(reply: WorkerReply) { this.onmessage?.(new MessageEvent<WorkerReply>('message', { data: reply })); }
  terminate() { this.terminated = true; }
}

it('shows useful snapshots during a fast stream instead of starving until EOF', async () => {
  vi.useFakeTimers();
  const worker = new FakeWorker();
  const published: (readonly AstBlock[])[] = [];
  const fail = vi.fn();
  const session = new MarkdownSession('attempt', (blocks) => published.push(blocks), fail, () => worker);
  for (let version = 1; version <= 50; version++) {
    session.update('word '.repeat(version), false);
    await vi.advanceTimersByTimeAsync(10);
  }
  expect(published.length).toBeGreaterThan(1);
  expect(published.at(-1)![0]!.to).toBeLessThan(250);
  session.update('word '.repeat(50), true);
  await vi.runAllTimersAsync();
  expect(published.at(-1)![0]!.to).toBe(250);
  expect(worker.maxActive).toBe(1);
  expect(worker.terminated).toBe(true);
  expect(fail).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps transferred unchanged block objects and accepts the last tail after finalization', async () => {
  vi.useFakeTimers();
  const worker = new FakeWorker(10);
  let blocks: readonly AstBlock[] = [];
  const session = new MarkdownSession('attempt', (next) => { blocks = next; }, vi.fn(), () => worker);
  session.update('# Stable\n\nTail', false);
  await vi.advanceTimersByTimeAsync(45);
  const first = blocks[0];
  session.update('# Stable\n\nTail grows', false);
  await vi.advanceTimersByTimeAsync(35);
  session.update('# Stable\n\nTail grows\n\nFinal', true);
  await vi.runAllTimersAsync();
  expect(blocks[0]).toBe(first);
  expect(blocks.at(-1)!.to).toBe('# Stable\n\nTail grows\n\nFinal'.length);
});

it('ignores another attempt and rejects an incompatible base version', async () => {
  vi.useFakeTimers();
  const worker = new FakeWorker(1000);
  const publish = vi.fn(); const fail = vi.fn();
  const session = new MarkdownSession('attempt', publish, fail, () => worker);
  session.update('text', false);
  await vi.advanceTimersByTimeAsync(35);
  const request = worker.requests[0]!;
  const result = new MarkdownEngine().update('text');
  const patch = { ...request, changed: [...result.blocks], order: result.blocks.map((block) => block.id), stats: result.stats };
  worker.deliver({ ...patch, documentId: 'old-attempt' });
  worker.deliver({ ...patch, epoch: request.epoch + 1 });
  expect(publish).not.toHaveBeenCalled();
  expect(fail).not.toHaveBeenCalled();
  worker.deliver({ ...patch, baseVersion: 99 });
  expect(fail).toHaveBeenCalledOnce();
  expect(worker.terminated).toBe(true);
  await vi.runAllTimersAsync();
});

it('cannot publish after disposal, even if a callback was already queued', async () => {
  vi.useFakeTimers();
  const worker = new FakeWorker(); const publish = vi.fn();
  const session = new MarkdownSession('attempt', publish, vi.fn(), () => worker);
  session.update('text', false);
  await vi.advanceTimersByTimeAsync(35);
  const callback = worker.onmessage!;
  const request = worker.requests[0]!;
  session.dispose();
  callback(new MessageEvent<WorkerReply>('message', { data: { ...request, error: 'late' } }));
  await vi.runAllTimersAsync();
  expect(publish).not.toHaveBeenCalled();
  expect(worker.terminated).toBe(true);
});
