export class DeadlineError extends Error {}

export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    parent.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      // Settle the deadline before notifying a cooperative adapter.
      reject(new DeadlineError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    if (parent.aborted) onAbort();
    return await Promise.race([
      interrupted,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', onAbort);
  }
}
