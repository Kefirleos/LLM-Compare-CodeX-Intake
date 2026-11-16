import type { ParserPort, ParseRequest } from './session';

interface Lease {
  port: ParserPort;
  queue: Lease[];
  request: ParseRequest | undefined;
  worker: ParserPort | undefined;
  inFlight: boolean;
  closed: boolean;
}

/** A stream keeps its parser state. Finished answers share the remaining worker slots. */
export class MarkdownWorkerPool {
  private streaming: Lease[] = [];
  private history: Lease[] = [];
  private idle: ParserPort[] = [];
  private workerCount = 0;
  private dispatching = false;

  constructor(private readonly createWorker: () => ParserPort, private readonly limit = 4) {}

  open(streaming: boolean): ParserPort {
    const port: ParserPort = {
      onmessage: null,
      onerror: null,
      postMessage: (request) => {
        if (lease.closed) return;
        if (lease.worker) {
          this.send(lease, lease.worker, request);
        } else {
          if (!lease.request) lease.queue.push(lease);
          lease.request = request;
          this.dispatch();
        }
      },
      terminate: () => this.close(lease),
    };
    const lease: Lease = { port, queue: streaming ? this.streaming : this.history, request: undefined, worker: undefined, inFlight: false, closed: false };
    return port;
  }

  private dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while ((this.streaming.length || this.history.length) && (this.idle.length || this.workerCount < this.limit)) {
        const lease = (this.streaming.shift() ?? this.history.shift())!;
        const request = lease.request!;
        lease.request = undefined;
        try {
          const worker = this.idle.pop() ?? this.create();
          lease.worker = worker;
          worker.onmessage = (event) => {
            if (lease.worker !== worker) return;
            lease.inFlight = false;
            lease.port.onmessage?.(event);
          };
          worker.onerror = (event) => {
            if (lease.worker === worker) this.fail(lease, event);
          };
          this.send(lease, worker, request);
        } catch {
          this.fail(lease, new ErrorEvent('error'));
        }
      }
      for (const worker of this.idle.splice(0)) this.retire(worker);
    } finally {
      this.dispatching = false;
    }
  }

  private create() {
    const worker = this.createWorker();
    this.workerCount++;
    return worker;
  }

  private send(lease: Lease, worker: ParserPort, request: ParseRequest) {
    lease.inFlight = true;
    try {
      worker.postMessage(request);
    } catch {
      this.fail(lease, new ErrorEvent('error'));
    }
  }

  private fail(lease: Lease, event: ErrorEvent) {
    lease.inFlight = true; // Never recycle a worker after its transport failed.
    try { lease.port.onerror?.(event); } finally { this.close(lease); }
  }

  private close(lease: Lease) {
    if (lease.closed) return;
    lease.closed = true;
    lease.port.onmessage = null;
    lease.port.onerror = null;
    if (lease.request) {
      const index = lease.queue.indexOf(lease);
      if (index !== -1) lease.queue.splice(index, 1);
      lease.request = undefined;
    }
    const worker = lease.worker;
    lease.worker = undefined;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      if (lease.inFlight) this.retire(worker);
      else this.idle.push(worker);
    }
    this.dispatch();
  }

  private retire(worker: ParserPort) {
    this.workerCount--;
    worker.terminate();
  }
}
