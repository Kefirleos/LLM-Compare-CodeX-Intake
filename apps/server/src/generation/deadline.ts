export class DeadlineError extends Error {
  constructor(readonly reason: 'total' | 'first_data' | 'idle' = 'total') { super(`Attempt timeout: ${reason}`); }
}

export interface StreamTimeouts { firstDataMs: number; idleMs: number }
export const defaultStreamTimeouts: StreamTimeouts = { firstDataMs: 60_000, idleMs: 30_000 };
export interface ActivityClock {
  activity(): void;
  pause(): void;
  resume(): void;
}

export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return withTimers((signal) => operation(signal), parent, timeoutMs);
}

export function withStreamDeadline<T>(
  operation: (signal: AbortSignal, clock: ActivityClock) => Promise<T>,
  parent: AbortSignal, totalMs: number, timeouts: StreamTimeouts,
): Promise<T> {
  return withTimers(operation, parent, totalMs, timeouts);
}

async function withTimers<T>(
  operation: (signal: AbortSignal, clock: ActivityClock) => Promise<T>,
  parent: AbortSignal, timeoutMs: number, activityTimeouts?: StreamTimeouts,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let paused = false;
  let received = false;
  let expire: (reason: 'total' | 'first_data' | 'idle') => void = () => {};
  const armActivity = () => {
    clearTimeout(activityTimer);
    if (!activityTimeouts || !active || paused || controller.signal.aborted) return;
    activityTimer = setTimeout(() => expire(received ? 'idle' : 'first_data'), received ? activityTimeouts.idleMs : activityTimeouts.firstDataMs);
  };
  const clock: ActivityClock = {
    activity() { if (!active || controller.signal.aborted) return; received = true; armActivity(); },
    pause() { paused = true; clearTimeout(activityTimer); },
    // After a local write pause, give upstream a fresh activity budget. Total never pauses.
    resume() { paused = false; armActivity(); },
  };
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new DOMException('Request cancelled', 'AbortError'));
      controller.abort();
    };
    parent.addEventListener('abort', onAbort, { once: true });
    expire = (reason) => {
      // Settle the deadline before notifying a cooperative adapter.
      reject(new DeadlineError(reason));
      controller.abort();
    };
    timer = setTimeout(() => expire('total'), timeoutMs);
    armActivity();
  });
  try {
    if (parent.aborted) onAbort();
    return await Promise.race([
      interrupted,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal, clock);
      }),
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
    clearTimeout(activityTimer);
    parent.removeEventListener('abort', onAbort);
  }
}
