/**
 * In-process single-flight (request coalescing) mechanism.
 * Ensures that multiple concurrent requests for the exact same key only execute
 * the underlying expensive task once, sharing the same Promise.
 */

export class SingleFlightGroup {
  private activeCalls = new Map<string, Promise<unknown>>();
  private waitersCount = 0;

  /**
   * Execute `fn` for `key`. If an execution for `key` is already in flight,
   * await and return its result instead of executing `fn` again.
   */
  async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.activeCalls.get(key);
    if (existing) {
      this.waitersCount++;
      try {
        return (await existing) as T;
      } finally {
        this.waitersCount = Math.max(0, this.waitersCount - 1);
      }
    }

    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.activeCalls.delete(key);
      }
    })();

    this.activeCalls.set(key, promise);
    return promise;
  }

  get inFlightCount(): number {
    return this.activeCalls.size;
  }

  get totalWaiters(): number {
    return this.waitersCount;
  }
}

// Global instance for application single-flight calls
const g = globalThis as unknown as { __minimiSingleFlight?: SingleFlightGroup };
export function getSingleFlight(): SingleFlightGroup {
  g.__minimiSingleFlight ??= new SingleFlightGroup();
  return g.__minimiSingleFlight;
}

