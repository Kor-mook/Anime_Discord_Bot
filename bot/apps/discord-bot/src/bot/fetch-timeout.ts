export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number, operation: string) {
    super(`${operation} timed out after ${timeoutMs} ms.`);
    this.name = 'TimeoutError';
  }
}

/** Combines an optional caller cancellation with a finite deadline. */
export function withTimeoutSignal(timeoutMs: number, operation: string, parent?: AbortSignal): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
  timeoutError: () => RequestTimeoutError;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new RequestTimeoutError(timeoutMs, operation));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
    timeoutError: () => new RequestTimeoutError(timeoutMs, operation)
  };
}
