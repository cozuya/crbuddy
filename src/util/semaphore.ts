/**
 * Concurrency gate. Defaults to unlimited (DESIGN.md §6) but exists from
 * day one so a cap is later a policy change rather than an engine rewrite.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  /** `limit` of 0 means unlimited. */
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.limit > 0 && this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    this.active += 1;

    let released = false;

    return () => {
      if (released) return;
      released = true;

      this.active -= 1;

      const next = this.waiting.shift();
      if (next) next();
    };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();

    try {
      return await task();
    } finally {
      release();
    }
  }
}
