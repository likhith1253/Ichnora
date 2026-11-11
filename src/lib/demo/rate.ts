import type { DB } from "../db";
import type { AppConfig } from "../env";

/**
 * Coarse per-IP rate limit for demo creation, so one visitor cannot spin up
 * unlimited demo workspaces and drain the owner's quotas.
 */

/**
 * Client address for rate limiting. Forwarding headers are client-controlled, so
 * they are ignored unless TRUST_PROXY is on (the app sits behind a proxy you
 * run). Then the RIGHT-most X-Forwarded-For hop is used: the one your proxy
 * appended, which the client cannot forge.
 */
export function clientIp(req: Request, trustProxy = false): string {
  if (!trustProxy) return "direct";
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",").map((x) => x.trim()).filter(Boolean).at(-1) ?? "unknown";
  return req.headers.get("x-real-ip")?.trim() || "direct";
}

export function allowDemoCreation(db: DB, ip: string, cfg: AppConfig, now = new Date()): boolean {
  const since = new Date(now.getTime() - cfg.DEMO_RATE_LIMIT_WINDOW_MINUTES * 60_000).toISOString();
  const row = db.prepare("SELECT COUNT(*) AS n FROM demo_ip_events WHERE ip = ? AND at >= ?").get(ip, since) as { n: number };
  if (row.n >= cfg.DEMO_RATE_LIMIT_MAX) return false;
  // Global ceiling: even rotating addresses cannot exceed it.
  const all = db.prepare("SELECT COUNT(*) AS n FROM demo_ip_events WHERE at >= ?").get(since) as { n: number };
  return all.n < cfg.DEMO_GLOBAL_MAX;
}

export function recordDemoCreation(db: DB, ip: string, now = new Date()): void {
  db.prepare("INSERT INTO demo_ip_events(ip, at) VALUES (?, ?)").run(ip, now.toISOString());
}

export function pruneDemoEvents(db: DB, before: string): number {
  return db.prepare("DELETE FROM demo_ip_events WHERE at < ?").run(before).changes;
}
