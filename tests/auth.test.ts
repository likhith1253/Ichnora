import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getConfig, type AppConfig } from "@/lib/env";
import {
  accountMetadata,
  claimWorkspace,
  createGuestUser,
  deleteAccount,
  ensurePersonalWorkspace,
  getWorkspace,
  getUser,
  resolveOwnedWorkspace,
  upsertUserFromProfile,
} from "@/lib/auth/accounts";
import type { OAuthProfile } from "@/lib/auth/providers";
import { createSession, deleteExpiredSessions, findSession, revokeSession, rotateSession } from "@/lib/auth/sessions";
import { authCookie, baseOrigin, clearAuthCookie, decodeState, encodeState, sameSecret } from "@/lib/auth/flow";
import { challengeFor, createState, createVerifier } from "@/lib/auth/pkce";
import { parseCookieHeader, readCookie, serializeCookie } from "@/lib/auth/cookies";
import { expectedOrigin, sameOrigin } from "@/lib/auth/csrf";
import { sign, verify } from "@/lib/auth/sign";
import { hashToken } from "@/lib/auth/tokens";
import { createConversation, insertMessage, listConversations } from "@/lib/db/repo";
import { createDemoWorkspace } from "@/lib/demo/store";
import { deleteWorkspace, exportWorkspace } from "@/lib/server/export";
import { safeInternalPath } from "@/lib/server/http";
import { redact } from "@/lib/server/log";
import { resolveWorkspace } from "@/lib/server/identity";
import { memDb } from "./helpers";

/* ------------------------------------------------------------------ fixtures */

const BASE = "http://localhost:3000";
const base = getConfig({} as NodeJS.ProcessEnv);
const LOCAL_CFG: AppConfig = base;
const AUTH_CFG: AppConfig = { ...base, AUTH_SECRET: "test-secret-do-not-use", GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" };

function req(method: string, path = "/", headers: Record<string, string> = {}, url = BASE): Request {
  return new Request(`${url}${path}`, { method, headers });
}

function profile(id: string): OAuthProfile {
  return { providerUserId: id, email: `${id}@example.com`, name: id, avatarUrl: null };
}

/** Create a real account with a personal workspace and a live session. */
function signIn(db: ReturnType<typeof memDb>, id: string) {
  const { user } = upsertUserFromProfile(db, "github", profile(id));
  const ws = ensurePersonalWorkspace(db, user.id);
  const { token } = createSession(db, { userId: user.id, kind: "user" });
  return { user, ws, token };
}

/* -------------------------------------------------- workspace resolution / IDOR */

describe("workspace isolation (AUTH mode)", () => {
  it("resolves the workspace from the session and ignores x-workspace-id", () => {
    const db = memDb();
    const a = signIn(db, "alice");
    const b = signIn(db, "bob");
    const id = resolveWorkspace(req("GET", "/", { cookie: `minimi_session=${a.token}`, "x-workspace-id": b.ws }), db, AUTH_CFG);
    expect(id.ok).toBe(true);
    if (!id.ok) return;
    expect(id.workspaceId).toBe(a.ws);
    expect(id.workspaceId).not.toBe(b.ws);
    expect(id.mode).toBe("auth");
    expect(id.user?.id).toBe(a.user.id);
  });

  it("401s without a session, even when a valid x-workspace-id is supplied", () => {
    const db = memDb();
    const b = signIn(db, "bob");
    const id = resolveWorkspace(req("GET", "/", { "x-workspace-id": b.ws }), db, AUTH_CFG);
    expect(id.ok).toBe(false);
    if (id.ok) return;
    expect(id.response.status).toBe(401);
  });

  it("user A cannot read user B's conversations (IDOR)", () => {
    const db = memDb();
    const a = signIn(db, "alice");
    const b = signIn(db, "bob");
    createConversation(db, b.ws, "Bob's private chat");
    const id = resolveWorkspace(req("GET", "/", { cookie: `minimi_session=${a.token}`, "x-workspace-id": b.ws }), db, AUTH_CFG);
    expect(id.ok).toBe(true);
    if (!id.ok) return;
    expect(listConversations(db, id.workspaceId)).toHaveLength(0);
  });

  it("user A cannot export or delete user B's data", () => {
    const db = memDb();
    const a = signIn(db, "alice");
    const b = signIn(db, "bob");
    insertMessage(db, { conversationId: createConversation(db, b.ws, "Bob's private chat").id, workspaceId: b.ws, role: "user", content: "secret", timezone: "Asia/Kolkata" });

    const idA = resolveWorkspace(req("GET", "/", { cookie: `minimi_session=${a.token}` }), db, AUTH_CFG);
    expect(idA.ok).toBe(true);
    if (!idA.ok) return;

    // A's own export carries none of B's data...
    const exported = exportWorkspace(db, idA.workspaceId);
    expect((exported.conversations as unknown[]).length).toBe(0);

    // ...and "forget everything" on A's workspace leaves B untouched.
    expect(deleteWorkspace(db, idA.workspaceId)).toBe(true);
    expect(getWorkspace(db, b.ws)).not.toBeNull();
    expect(listConversations(db, b.ws)).toHaveLength(1);
  });

  it("AUTH mode also refuses anonymous cross-site state changes", () => {
    const db = memDb();
    const a = signIn(db, "alice");
    const id = resolveWorkspace(req("POST", "/", { cookie: `minimi_session=${a.token}`, origin: "http://evil.example" }), db, AUTH_CFG);
    expect(id.ok).toBe(false);
    if (id.ok) return;
    expect(id.response.status).toBe(403);
  });

  it("AUTH mode honours a demo cookie as an isolated demo workspace", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, AUTH_CFG, new Date("2026-11-10T10:00:00Z"));
    const { token } = createSession(db, { userId: demo.userId, kind: "demo" });
    const other = randomUUID();
    const id = resolveWorkspace(req("GET", "/", { cookie: `minimi_session=${token}`, "x-workspace-id": other }), db, AUTH_CFG);
    expect(id.ok).toBe(true);
    if (!id.ok) return;
    expect(id.workspaceId).toBe(demo.workspaceId);
    expect(id.demo).toBe(true);
    expect(id.user).toBeNull();
  });
});

describe("workspace resolution (LOCAL mode — unchanged)", () => {
  it("still uses the x-workspace-id header", () => {
    const db = memDb();
    const ws = randomUUID();
    const id = resolveWorkspace(req("GET", "/", { "x-workspace-id": ws }), db, LOCAL_CFG);
    expect(id.ok).toBe(true);
    if (!id.ok) return;
    expect(id.workspaceId).toBe(ws);
    expect(id.mode).toBe("local");
  });

  it("400s without a header and never trusts a real account cookie", () => {
    const db = memDb();
    const a = signIn(db, "alice");
    const id = resolveWorkspace(req("GET", "/", { cookie: `minimi_session=${a.token}` }), db, LOCAL_CFG);
    expect(id.ok).toBe(false);
    if (id.ok) return;
    expect(id.response.status).toBe(400);
  });

  it("honours a demo cookie so Try demo works without any OAuth keys", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, LOCAL_CFG, new Date("2026-11-10T10:00:00Z"));
    const { token } = createSession(db, { userId: demo.userId, kind: "demo" });
    const id = resolveWorkspace(req("GET", "/", { cookie: `minimi_session=${token}` }), db, LOCAL_CFG);
    expect(id.ok).toBe(true);
    if (!id.ok) return;
    expect(id.workspaceId).toBe(demo.workspaceId);
    expect(id.demo).toBe(true);
  });
});

/* ----------------------------------------------------------------- CSRF */

describe("CSRF (origin / referer)", () => {
  it("accepts same-origin signals and all safe methods", () => {
    expect(expectedOrigin(req("POST", "/"), BASE)).toBe(BASE);
    expect(sameOrigin(req("POST", "/", { origin: BASE }), BASE)).toBe(true);
    expect(sameOrigin(req("POST", "/", { referer: `${BASE}/chat` }), BASE)).toBe(true);
    expect(sameOrigin(req("GET", "/", { origin: "http://evil.example" }), BASE)).toBe(true); // GET is safe
  });

  it("rejects missing, foreign and malformed signals on state-changing requests", () => {
    expect(sameOrigin(req("POST", "/"), BASE)).toBe(false);
    expect(sameOrigin(req("POST", "/", { origin: "http://evil.example" }), BASE)).toBe(false);
    expect(sameOrigin(req("POST", "/", { referer: "http://evil.example/x" }), BASE)).toBe(false);
    expect(sameOrigin(req("DELETE", "/"), BASE)).toBe(false);
    expect(expectedOrigin(req("POST", "/"), "not a url")).toBe(BASE);
  });
});

/* --------------------------------------------------------------- sessions */

describe("sessions", () => {
  it("stores only a SHA-256 hash of the token, never the token itself", () => {
    const db = memDb();
    const { user } = upsertUserFromProfile(db, "github", profile("u1"));
    const { token } = createSession(db, { userId: user.id });
    const row = db.prepare("SELECT token_hash FROM sessions").get() as { token_hash: string };
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.token_hash).not.toBe(token);
    expect(JSON.stringify(db.prepare("SELECT * FROM sessions").all())).not.toContain(token);
  });

  it("honours expiry and deletes the expired row on lookup", () => {
    const db = memDb();
    const { user } = upsertUserFromProfile(db, "github", profile("u2"));
    const now = new Date("2026-11-10T10:00:00Z");
    const { token } = createSession(db, { userId: user.id, now, ttlMs: 1000 });
    expect(findSession(db, token, new Date(now.getTime() + 500))).not.toBeNull();
    expect(findSession(db, token, new Date(now.getTime() + 5_000))).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
  });

  it("revoking a session makes its token unusable (sign-out is idempotent)", () => {
    const db = memDb();
    const { user } = upsertUserFromProfile(db, "github", profile("u3"));
    const { token } = createSession(db, { userId: user.id });
    expect(revokeSession(db, token)).toBe(true);
    expect(findSession(db, token)).toBeNull();
    expect(revokeSession(db, token)).toBe(false);
  });

  it("issues distinct tokens per sign-in and rotates them (session fixation)", () => {
    const db = memDb();
    const { user } = upsertUserFromProfile(db, "github", profile("u4"));
    const first = createSession(db, { userId: user.id });
    const second = createSession(db, { userId: user.id });
    expect(first.token).not.toBe(second.token);

    const rotated = rotateSession(db, first.token);
    expect(rotated).not.toBeNull();
    expect(rotated!.token).not.toBe(first.token);
    expect(findSession(db, first.token)).toBeNull(); // old token is dead
    expect(findSession(db, rotated!.token)).not.toBeNull();
    expect(findSession(db, second.token)).not.toBeNull(); // unrelated session untouched
  });

  it("deleteExpiredSessions clears only the expired rows", () => {
    const db = memDb();
    const { user } = upsertUserFromProfile(db, "github", profile("u5"));
    const now = new Date("2026-11-10T10:00:00Z");
    createSession(db, { userId: user.id, now, ttlMs: 1000 });
    createSession(db, { userId: user.id, now, ttlMs: 3_600_000 });
    expect(deleteExpiredSessions(db, new Date(now.getTime() + 60_000))).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
  });
});

/* ------------------------------------------------------ open redirects */

describe("open redirects (safeInternalPath)", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeInternalPath("/")).toBe("/");
    expect(safeInternalPath("/c/abc?x=1")).toBe("/c/abc?x=1");
    expect(safeInternalPath("/signin?next=%2F")).toBe("/signin?next=%2F");
  });

  it("rejects absolute, protocol-relative, backslash and multiline targets", () => {
    expect(safeInternalPath("//evil.example")).toBe("/");
    expect(safeInternalPath("https://evil.example")).toBe("/");
    expect(safeInternalPath("http://evil.example/x")).toBe("/");
    expect(safeInternalPath("/\\evil.example")).toBe("/");
    expect(safeInternalPath("\\evil")).toBe("/");
    expect(safeInternalPath("/foo\\bar")).toBe("/");
    expect(safeInternalPath("/foo\nbar")).toBe("/");
    expect(safeInternalPath("/foo\rbar")).toBe("/");
    expect(safeInternalPath(null)).toBe("/");
    expect(safeInternalPath("", "/home")).toBe("/home");
  });
});

/* ------------------------------------------------------------ cookie flags */

describe("cookie flags", () => {
  it("session cookie is httpOnly + SameSite=Lax, Secure only over https", () => {
    const insecure = authCookie("minimi_session", "tok", 3600, false);
    expect(insecure).toContain("HttpOnly");
    expect(insecure).toContain("SameSite=Lax");
    expect(insecure).toContain("Path=/");
    expect(insecure).toContain("Max-Age=3600");
    expect(insecure).not.toContain("Secure");
    expect(authCookie("minimi_session", "tok", 3600, true)).toContain("Secure");
    expect(clearAuthCookie("minimi_session")).toContain("Max-Age=0");
  });

  it("parses and reads a single cookie out of a header", () => {
    const r = req("GET", "/", { cookie: "a=1; minimi_session=xyz; b=2" });
    expect(readCookie(r, "minimi_session")).toBe("xyz");
    expect(readCookie(r, "missing")).toBeNull();
    expect(parseCookieHeader(null)).toEqual({});
    expect(serializeCookie("x", "y", { maxAge: 0 })).toContain("Max-Age=0");
  });
});

/* ---------------------------------------------------------------- account */

describe("claiming and deletion", () => {
  it("claims only an unowned local workspace and discards the empty personal one", () => {
    const db = memDb();
    const { user } = upsertUserFromProfile(db, "github", profile("c1"));
    const personal = ensurePersonalWorkspace(db, user.id);
    const local = randomUUID();
    db.prepare("INSERT INTO workspaces(id, created_at) VALUES (?, ?)").run(local, new Date().toISOString());
    createConversation(db, local, "Existing local chat");

    expect(claimWorkspace(db, user.id, local)).toBe(true);
    expect(getWorkspace(db, local)?.ownerUserId).toBe(user.id);
    expect(getWorkspace(db, local)?.kind).toBe("user");
    expect(getWorkspace(db, personal)).toBeNull(); // empty auto-created workspace is gone
    expect(claimWorkspace(db, user.id, local)).toBe(false); // already owned
  });

  it("refuses to claim a workspace that is already owned by someone else", () => {
    const db = memDb();
    const a = signIn(db, "alice");
    const b = signIn(db, "bob");
    expect(claimWorkspace(db, b.user.id, a.ws)).toBe(false);
    expect(getWorkspace(db, a.ws)?.ownerUserId).toBe(a.user.id);
  });

  it("deleting an account cascades to its workspaces and data", () => {
    const db = memDb();
    const a = signIn(db, "alice");
    insertMessage(db, { conversationId: createConversation(db, a.ws, "private").id, workspaceId: a.ws, role: "user", content: "hi", timezone: "Asia/Kolkata" });
    deleteAccount(db, a.user.id);
    expect(getUser(db, a.user.id)).toBeNull();
    expect(getWorkspace(db, a.ws)).toBeNull();
    expect(listConversations(db, a.ws)).toHaveLength(0);
  });

  it("export includes account metadata but never tokens", () => {
    const db = memDb();
    const a = signIn(db, "alice");
    createConversation(db, a.ws, "hello");
    const meta = accountMetadata(db, a.user.id);
    expect(meta).not.toBeNull();
    const exported = exportWorkspace(db, a.ws, meta);
    expect(exported.account).toMatchObject({ id: a.user.id, name: "alice" });
    const blob = JSON.stringify(exported);
    expect(blob).not.toContain(a.token);
    expect(blob).not.toContain("token_hash");
  });

  it("a demo workspace resolves only while unexpired", () => {
    const db = memDb();
    const now = new Date("2026-11-10T10:00:00Z");
    const userId = createGuestUser(db, now);
    db.prepare("INSERT INTO workspaces(id, created_at, owner_user_id, kind, expires_at) VALUES (?, ?, ?, 'demo', ?)").run(
      randomUUID(),
      now.toISOString(),
      userId,
      new Date(now.getTime() + 3_600_000).toISOString(),
    );
    expect(resolveOwnedWorkspace(db, userId, "demo", now)).not.toBeNull();
    expect(resolveOwnedWorkspace(db, userId, "demo", new Date(now.getTime() + 2 * 3_600_000))).toBeNull();
  });
});

/* ------------------------------------------------------ oauth handshake */

describe("oauth handshake", () => {
  it("signs the state so tampering and forgery are detected", () => {
    const signed = encodeState({ provider: "github", state: "s1", verifier: "v1", next: "/x" }, "secret");
    expect(decodeState(signed, "secret")).toMatchObject({ provider: "github", state: "s1", next: "/x" });
    expect(decodeState(signed, "other-secret")).toBeNull();
    expect(decodeState(`${signed}a`, "secret")).toBeNull();
    expect(decodeState("garbage", "secret")).toBeNull();
    expect(verify(sign("payload", "k"), "wrong")).toBeNull();
    expect(verify("no-dot", "k")).toBeNull();
  });

  it("PKCE challenge is the deterministic S256 of the verifier", () => {
    const v = createVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(challengeFor(v)).toBe(challengeFor(v));
    expect(challengeFor(v)).not.toBe(v);
    expect(createState()).not.toBe(createState());
  });

  it("compares the echoed state in constant time", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abcd")).toBe(false);
  });

  it("builds the callback origin from PUBLIC_BASE_URL, else the request", () => {
    const r = req("GET", "/");
    expect(baseOrigin(r, { ...AUTH_CFG, PUBLIC_BASE_URL: "https://ichnora.example" })).toBe("https://ichnora.example");
    expect(baseOrigin(r, { ...AUTH_CFG, PUBLIC_BASE_URL: undefined })).toBe(BASE);
    expect(baseOrigin(r, { ...AUTH_CFG, PUBLIC_BASE_URL: "not a url" })).toBe(BASE);
  });
});

/* ------------------------------------------------------------ log redaction */

describe("log redaction", () => {
  it("scrubs provider keys, bearer tokens and token fields", () => {
    expect(redact("key gsk_abcdefghijklmno12345")).not.toContain("gsk_abcdefghijklmno12345");
    expect(redact("Authorization: Bearer abcdefghijklmnopqrst")).toContain("[redacted]");
    expect(redact('{"token":"supersecretvaluehere"}')).not.toContain("supersecretvaluehere");
    expect(redact('{"api_key": "abcdefgh12345678"}')).not.toContain("abcdefgh12345678");
    expect(redact("nothing to hide here")).toBe("nothing to hide here");
  });
});
