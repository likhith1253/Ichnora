export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureThreshold?: number;      // Consecutive failures to trip (default: 3)
  recoveryTimeoutMs?: number;     // How long to stay OPEN before HALF_OPEN (default: 30s)
  halfOpenMaxCalls?: number;      // Successful probes in HALF_OPEN to close (default: 2)
}

export interface CircuitStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastStateChange: number;
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private halfOpenSuccesses = 0;
  private lastFailureTime: number | null = null;
  private lastStateChange = Date.now();

  readonly failureThreshold: number;
  readonly recoveryTimeoutMs: number;
  readonly halfOpenMaxCalls: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.recoveryTimeoutMs = opts.recoveryTimeoutMs ?? 30_000;
    this.halfOpenMaxCalls = opts.halfOpenMaxCalls ?? 2;
  }

  getState(now: number = Date.now()): CircuitState {
    if (this.state === "OPEN") {
      if (now - this.lastStateChange >= this.recoveryTimeoutMs) {
        this.transitionTo("HALF_OPEN", now);
      }
    }
    return this.state;
  }

  isAvailable(now: number = Date.now()): boolean {
    const s = this.getState(now);
    return s === "CLOSED" || s === "HALF_OPEN";
  }

  recordSuccess(now: number = Date.now()): void {
    const s = this.getState(now);
    if (s === "HALF_OPEN") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.halfOpenMaxCalls) {
        this.transitionTo("CLOSED", now);
        this.failures = 0;
        this.halfOpenSuccesses = 0;
      }
    } else if (s === "CLOSED") {
      this.failures = 0;
    }
  }

  recordFailure(now: number = Date.now(), isPermanent: boolean = false): void {
    this.lastFailureTime = now;
    if (isPermanent) {
      this.transitionTo("OPEN", now);
      return;
    }

    const s = this.getState(now);
    if (s === "HALF_OPEN") {
      // In half-open, any failure trips back to OPEN immediately
      this.transitionTo("OPEN", now);
      this.halfOpenSuccesses = 0;
    } else if (s === "CLOSED") {
      this.failures++;
      if (this.failures >= this.failureThreshold) {
        this.transitionTo("OPEN", now);
      }
    }
  }

  reset(): void {
    this.state = "CLOSED";
    this.failures = 0;
    this.halfOpenSuccesses = 0;
    this.lastFailureTime = null;
    this.lastStateChange = Date.now();
  }

  private transitionTo(newState: CircuitState, now: number): void {
    this.state = newState;
    this.lastStateChange = now;
  }

  getStats(): CircuitStats {
    return {
      state: this.getState(),
      failures: this.failures,
      successes: this.halfOpenSuccesses,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
    };
  }
}
