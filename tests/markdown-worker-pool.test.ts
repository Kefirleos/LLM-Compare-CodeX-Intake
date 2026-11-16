// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { MarkdownWorkerPool } from '../apps/web/src/features/markdown/workerPool';
import type { ParserPort, ParseRequest, WorkerReply } from '../apps/web/src/features/markdown/session';

class FakeWorker implements ParserPort {
  onmessage: ParserPort['onmessage'] = null;
  onerror: ParserPort['onerror'] = null;
  readonly requests: ParseRequest[] = [];
  private inFlight: ParseRequest | undefined;
  terminate = vi.fn();

  postMessage(request: ParseRequest) {
    expect(this.inFlight).toBeUndefined();
    this.inFlight = request;
    this.requests.push(request);
  }

  complete() {
    expect(this.inFlight).toBeDefined();
    const { text: _, ...identity } = this.inFlight!;
    this.inFlight = undefined;
    const data: WorkerReply = { ...identity, error: 'test reply' };
    this.onmessage?.(new MessageEvent<WorkerReply>('message', { data }));
  }
}

function setup(limit?: number) {
  const workers: FakeWorker[] = [];
  const pool = new MarkdownWorkerPool(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, limit);
  return { pool, workers };
}

function submit(pool: MarkdownWorkerPool, documentId: string, streaming = false) {
  const port = pool.open(streaming);
  const received = vi.fn((event: MessageEvent<WorkerReply>) => {
    expect(event.data.documentId).toBe(documentId);
    port.terminate();
  });
  port.onmessage = received;
  port.postMessage({ documentId, epoch: 0, baseVersion: 0, version: 1, text: documentId });
  return { port, received };
}

it('bounds concurrent historical parses to four workers and reuses them across answers', () => {
  const { pool, workers } = setup();
  const answers = Array.from({ length: 100 }, (_, index) => submit(pool, `answer-${index}`));
  expect(workers).toHaveLength(4);
  expect(workers.map((worker) => worker.requests.length)).toEqual([1, 1, 1, 1]);
  for (let round = 0; round < 25; round++) {
    for (const worker of workers) worker.complete();
  }
  expect(workers).toHaveLength(4);
  expect(workers.map((worker) => worker.requests.length)).toEqual([25, 25, 25, 25]);
  for (const answer of answers) expect(answer.received).toHaveBeenCalledOnce();
  for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
});

it('puts queued streaming parses first and removes abandoned history from the queue', () => {
  const { pool, workers } = setup(1);
  submit(pool, 'running');
  const closed = submit(pool, 'closed');
  submit(pool, 'history');
  submit(pool, 'stream', true);
  closed.port.terminate();
  const [worker] = workers;
  worker!.complete();
  expect(worker!.requests.map((request) => request.documentId)).toEqual(['running', 'stream']);
  worker!.complete();
  expect(worker!.requests.map((request) => request.documentId)).toEqual(['running', 'stream', 'history']);
  worker!.complete();
  expect(closed.received).not.toHaveBeenCalled();
  expect(worker!.terminate).toHaveBeenCalledOnce();
});

it('discards a cancelled active worker and retires a worker that reports an error', () => {
  const { pool, workers } = setup(1);
  const active = submit(pool, 'active');
  const queued = submit(pool, 'queued');
  const last = submit(pool, 'last');
  const [cancelledWorker] = workers;
  const late = cancelledWorker!.onmessage!;
  active.port.terminate();
  late(new MessageEvent<WorkerReply>('message', { data: { documentId: 'active', epoch: 0, baseVersion: 0, version: 1, error: 'late' } }));
  expect(active.received).not.toHaveBeenCalled();
  expect(cancelledWorker!.terminate).toHaveBeenCalledOnce();
  const failedWorker = workers[1]!;
  queued.port.onerror = vi.fn();
  const failure = queued.port.onerror;
  failedWorker.onerror!(new ErrorEvent('error'));
  expect(failure).toHaveBeenCalledOnce();
  expect(failedWorker.terminate).toHaveBeenCalledOnce();
  expect(queued.received).not.toHaveBeenCalled();
  workers[2]!.complete();
  expect(last.received).toHaveBeenCalledOnce();
  expect(workers[2]!.terminate).toHaveBeenCalledOnce();
});
