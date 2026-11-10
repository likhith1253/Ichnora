import type { DB } from "../db";
import type { AppConfig } from "../env";

/**
 * Coarse per-IP rate limit for demo creation, so one visitor cannot spin up
 * unlimited demo workspaces and drain the owner's quotas.
 */

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "local";
}

export function allowDemoCreation(db: DB, ip: string, cfg: AppConfig, now = new Date()): boolean {
  const since = new Date(now.getTime() - cfg.DEMO_RATE_LIMIT_WINDOW_MINUTES * 60_000).toISOString();
  const row = db.prepare("SELECT COUNT(*) AS n FROM demo_ip_events WHERE ip = ? AND at >= ?").get(ip, since) as { n: number };
  return row.n < cfg.DEMO_RATE_LIMIT_MAX;
}

export function recordDemoCreation(db: DB, ip: string, now = new Date()): void {
  db.prepare("INSERT INTO demo_ip_events(ip, at) VALUES (?, ?)").run(ip, now.toISOString());
}

export function pruneDemoEvents(db: DB, before: string): number {
  return db.prepare("DELETE FROM demo_ip_events WHERE at < ?").run(before).changes;
}
