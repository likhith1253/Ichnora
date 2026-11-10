import type { DB } from "../db";
import type { ExtractOutcome, SearchOutcome, SearchProvider, SearchQuery } from "./types";

/**
 * Free-tier credit governance for the search layer.
 *
 * - Every Tavily call is recorded in `api_usage` (persisted; survives restarts).
 * - The account's real usage is synced from Tavily's free `GET /usage` endpoint
 *   at most every 10 minutes, and the higher of (ledger, account) is trusted.
 * - A reserve is kept for high-priority turns ("has it changed since?"), so
 *   routine questions cannot drain the credits needed for change checks.
 * - When the budget is exhausted the call is refused locally — Tavily is not
 *   contacted, nothing is billed, and the agent says search is unavailable.
 */

export interface BudgetConfig {
  monthlyLimit: number;
  reserve: number;
}

export type Priority = "normal" | "high";

export function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export class CreditLedger {
  private synced: { month: string; used: number; at: number } | null = null;
  constructor(
    private db: DB,
    private cfg: BudgetConfig,
    private now: () => Date = () => new Date(),
  ) {}

  usedThisMonth(): number {
    const month = monthOf(this.now());
    const row = this.db.prepare("SELECT COALESCE(SUM(units), 0) AS u FROM api_usage WHERE provider = 'tavily' AND month = ?").get(month) as { u: number };
    const synced = this.synced?.month === month ? this.synced.used : 0;
    return Math.max(row.u, synced);
  }

  remaining(): number {
    return Math.max(0, this.cfg.monthlyLimit - this.usedThisMonth());
  }

  canSpend(units: number, priority: Priority): boolean {
    const floor = priority === "high" ? 0 : this.cfg.reserve;
    return this.remaining() - units >= floor;
  }

  record(kind: "search" | "extract", units: number, messageId: string | null): void {
    if (units <= 0) return;
    this.db
      .prepare("INSERT INTO api_usage(provider, kind, month, units, at, message_id) VALUES ('tavily', ?, ?, ?, ?, ?)")
      .run(kind, monthOf(this.now()), units, this.now().toISOString(), messageId);
  }

  setAccountUsage(used: number): void {
    this.synced = { month: monthOf(this.now()), used, at: this.now().getTime() };
  }

  needsSync(): boolean {
    return !this.synced || this.now().getTime() - this.synced.at > 10 * 60_000;
  }
}

/** Process-wide sync cache so per-request providers don't each call /usage. */
const accountCache: { used: number; at: number } = { used: -1, at: 0 };

/**
 * Wraps any SearchProvider with budget checks and accounting. Created per
 * request; `context` is set by the agent once the turn's priority is known.
 */
export class BudgetedSearch implements SearchProvider {
  readonly name: string;
  context: { priority: Priority; messageId: string | null } = { priority: "normal", messageId: null };
  constructor(
    private inner: SearchProvider,
    private ledger: CreditLedger,
    private syncUsage?: () => Promise<number | null>,
  ) {
    this.name = `${inner.name}+budget`;
  }

  private async sync(): Promise<void> {
    if (!this.syncUsage) return;
    if (accountCache.used >= 0 && Date.now() - accountCache.at < 10 * 60_000) {
      this.ledger.setAccountUsage(accountCache.used);
      return;
    }
    try {
      const used = await this.syncUsage();
      if (used !== null) {
        accountCache.used = used;
        accountCache.at = Date.now();
        this.ledger.setAccountUsage(used);
      }
    } catch {
      /* usage endpoint is best-effort; the local ledger still applies */
    }
  }

  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchOutcome> {
    if (this.ledger.needsSync()) await this.sync();
    if (!this.ledger.canSpend(1, this.context.priority)) {
      return {
        query: q.query,
        hits: [],
        error: {
          kind: "budget",
          message:
            this.context.priority === "high"
              ? "The monthly free search credits are used up."
              : "Free search credits are running low and are reserved for change checks.",
        },
      };
    }
    const out = await this.inner.search(q, signal);
    if (!out.error) this.ledger.record("search", 1, this.context.messageId);
    return out;
  }

  async extract(urls: string[], query: string, signal: AbortSignal): Promise<ExtractOutcome> {
    if (!this.inner.extract) return { pages: [] };
    const estimate = Math.ceil(urls.length / 5);
    if (!this.ledger.canSpend(estimate, this.context.priority)) {
      return { pages: [], error: { kind: "budget", message: "Not enough free credits left to read full pages." } };
    }
    const out = await this.inner.extract(urls, query, signal);
    const ok = out.pages.filter((p) => p.ok).length;
    this.ledger.record("extract", Math.ceil(ok / 5), this.context.messageId);
    return out;
  }
}

/** Read the account's plan usage from Tavily's free usage endpoint. */
export function tavilyUsageFetcher(apiKey: string): () => Promise<number | null> {
  return async () => {
    const res = await fetch("https://api.tavily.com/usage", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { account?: { plan_usage?: unknown } };
    return typeof j.account?.plan_usage === "number" ? j.account.plan_usage : null;
  };
}
