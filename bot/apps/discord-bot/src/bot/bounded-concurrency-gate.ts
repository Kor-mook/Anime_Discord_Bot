export class ServerBusyError extends Error {
  constructor(message = 'The server is busy. Please try again shortly.') {
    super(message);
    this.name = 'ServerBusyError';
  }
}

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** A finite, promise-based semaphore with queue length and wait-time limits. */
export class BoundedConcurrencyGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly maxConcurrency: number,
    readonly maxQueue: number,
    readonly queueTimeoutMs: number
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('maxConcurrency must be a positive integer.');
    if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new Error('maxQueue must be a non-negative integer.');
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 1) throw new Error('queueTimeoutMs must be positive.');
  }

  get activeCount(): number { return this.active; }
  get waitingCount(): number { return this.waiters.length; }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.waiters.length >= this.maxQueue) return Promise.reject(new ServerBusyError('The server queue is full. Please try again shortly.'));

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new ServerBusyError('The server is busy. Please try again shortly.'));
        }, this.queueTimeoutMs)
      };
      this.waiters.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.releaseOnce());
        return;
      }
      this.active -= 1;
    };
  }
}
