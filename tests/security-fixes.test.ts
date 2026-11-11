/**
 * Regression tests for the identity/demo review findings (11 Nov 2026).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/env";
import { createSession, findSession } from "@/lib/auth/sessions";
import { allowDemoCreation, recordDemoCreation } from "@/lib/demo/rate";
import { cleanupDemoData, createDemoWorkspace } from "@/lib/demo/store";
import { resolveWorkspace, SESSION_COOKIE } from "@/lib/server/identity";
import { memDb } from "./helpers";

const local = getConfig({} as NodeJS.ProcessEnv); // LOCAL mode: no OAuth configured
const req = (headers: Record<string, string>) => new Request("http://localhost:3000/api/conversations", { headers });

describe("LOCAL-mode header path", () => {
  it("opens an unowned local workspace by header (unchanged behaviour)", () => {
    const db = memDb();
    const ws = randomUUID();
    const r = resolveWorkspace(req({ "x-workspace-id": ws }), db, local);
    expect(r.ok && r.workspaceId).toBe(ws);
  });

  it("refuses a demo workspace by bare header (needs its session cookie)", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, local);
    const r = resolveWorkspace(req({ "x-workspace-id": demo.workspaceId }), db, local);
    expect(r.ok).toBe(false);
  });

  it("refuses an account-owned workspace by bare header", () => {
    const db = memDb();
    const userId = randomUUID();
    const ws = randomUUID();
    const t = new Date().toISOString();
    db.prepare("INSERT INTO users(id, created_at, updated_at, name) VALUES (?, ?, ?, 'Real user')").run(userId, t, t);
    db.prepare("INSERT INTO workspaces(id, created_at, owner_user_id, kind) VALUES (?, ?, ?, 'user')").run(ws, t, userId);
    expect(resolveWorkspace(req({ "x-workspace-id": ws }), db, local).ok).toBe(false);
  });

  it("still lets the demo session cookie reach its own workspace", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, local);
    const { token } = createSession(db, { userId: demo.userId, kind: "demo", ttlMs: 3_600_000, userAgent: null });
    const r = resolveWorkspace(req({ cookie: `${SESSION_COOKIE}=${token}`, origin: "http://localhost:3000", host: "localhost:3000" }), db, local);
    expect(r.ok && r.workspaceId).toBe(demo.workspaceId);
  });
});

describe("demo creation limits", () => {
  it("a global cap holds even when every request claims a new IP", () => {
    const db = memDb();
    const cfg = { ...local, DEMO_RATE_LIMIT_MAX: 5, DEMO_GLOBAL_MAX: 3 };
    for (let i = 0; i < 3; i++) {
      expect(allowDemoCreation(db, `ip-${i}`, cfg)).toBe(true);
      recordDemoCreation(db, `ip-${i}`);
    }
    expect(allowDemoCreation(db, "ip-fresh", cfg)).toBe(false);
  });
});

describe("guest cleanup", () => {
  it("never deletes a real OAuth user who happens to be named 'Try demo'", () => {
    const db = memDb();
    const t = new Date().toISOString();
    const uid = randomUUID();
    db.prepare("INSERT INTO users(id, created_at, updated_at, name) VALUES (?, ?, ?, 'Try demo')").run(uid, t, t);
    db.prepare("INSERT INTO oauth_accounts(provider, provider_user_id, user_id, created_at) VALUES ('github', '42', ?, ?)").run(uid, t);
    cleanupDemoData(db, local, new Date(Date.now() + 10 * 86_400_000));
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(uid)).toEqual({ n: 1 });
  });
});

describe("demo reset never touches a real user session", () => {
  it("returns 401 and keeps the user's session valid", async () => {
    const db = memDb();
    const t = new Date().toISOString();
    const uid = randomUUID();
    db.prepare("INSERT INTO users(id, created_at, updated_at, name) VALUES (?, ?, ?, 'Real')").run(uid, t, t);
    const { token } = createSession(db, { userId: uid, kind: "user", ttlMs: 3_600_000, userAgent: null });
    const { setDbForTesting } = await import("@/lib/db");
    setDbForTesting(db);
    try {
      const { POST } = await import("@/app/api/demo/reset/route");
      const res = await POST(new Request("http://localhost:3000/api/demo/reset", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: "http://localhost:3000", host: "localhost:3000" } }));
      expect(res.status).toBe(401);
      expect(findSession(db, token)).not.toBeNull();
    } finally {
      setDbForTesting(undefined);
    }
  });
});
