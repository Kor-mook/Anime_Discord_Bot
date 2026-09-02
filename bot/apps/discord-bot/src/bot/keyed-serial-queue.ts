/** Runs work for each key in order while allowing unrelated keys to overlap. */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    const tail = task.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return task;
  }

  get size(): number {
    return this.tails.size;
  }
}
