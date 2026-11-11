/**
 * Tokens-per-minute pacing for Groq's free tier (8K TPM verified via
 * x-ratelimit headers). Instead of sending a request that will 429 and then
 * waiting out SDK backoff, we wait briefly *before* sending when the sliding
 * 60-second window is nearly full. Bounded: never waits longer than `maxWaitMs`.
 */
export class TokenGate {
  private window: Array<{ at: number; tokens: number }> = [];
  constructor(
    private limitPerMinute: number,
    private now: () => number = () => Date.now(),
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private prune(): void {
    const cutoff = this.now() - 60_000;
    this.window = this.window.filter((e) => e.at > cutoff);
  }

  used(): number {
    this.prune();
    return this.window.reduce((s, e) => s + e.tokens, 0);
  }

  /** Wait until `estimate` more tokens fit in the window. Returns ms waited. */
  async waitFor(estimate: number, signal?: AbortSignal, maxWaitMs = 25_000): Promise<number> {
    let waited = 0;
    while (this.used() + estimate > this.limitPerMinute * 0.95 && this.window.length > 0 && waited < maxWaitMs) {
      if (signal?.aborted) break;
      const oldest = this.window[0]!;
      const ms = Math.min(maxWaitMs - waited, Math.max(250, oldest.at + 60_000 - this.now() + 50));
      await this.sleep(ms);
      waited += ms;
    }
    return waited;
  }

  record(tokens: number): void {
    if (tokens > 0) this.window.push({ at: this.now(), tokens });
  }
}

/** Process-wide gate (one Groq key per server process). */
const g = globalThis as unknown as { __ichnoraGate?: TokenGate };
export function sharedGate(limit: number): TokenGate {
  g.__ichnoraGate ??= new TokenGate(limit);
  return g.__ichnoraGate;
}
