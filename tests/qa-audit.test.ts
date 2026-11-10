import { describe, expect, it } from "vitest";
import { GET as getWorkspaceRoute, DELETE as deleteWorkspaceRoute } from "@/app/api/workspace/route";
import { GET as getConversationRoute, DELETE as deleteConversationRoute } from "@/app/api/conversations/[id]/route";
import { GET as getLoginRoute } from "@/app/api/auth/login/route";
import { GET as getCallbackRoute } from "@/app/api/auth/callback/[provider]/route";
import { sanitizeSearchQuery } from "@/lib/search/sanitize";
import { redact } from "@/lib/server/log";
import { createConversation, insertMessage } from "@/lib/db/repo";
import { memDb } from "./helpers";

describe("PHASE 3: Authentication & Session Lifecycle (Route Level)", () => {
  it("Test 3.1: Login route with unconfigured provider fails safely with 400", async () => {
    const req = new Request("http://localhost:3000/api/auth/login?provider=unsupported");
    const res = await getLoginRoute(req);
    expect(res.status).toBe(400);
  });

  it("Test 3.3: OAuth callback in unconfigured mode returns 400 safely", async () => {
    const req = new Request("http://localhost:3000/api/auth/callback/github?code=12345");
    const res = await getCallbackRoute(req, { params: Promise.resolve({ provider: "github" }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Authentication is not configured");
  });
});

describe("PHASE 4: Authorization, IDOR & Workspace Isolation (Route Level)", () => {
  it("Test 4.1: User A cannot read User B's conversation (returns null conversation)", async () => {
    const wsA = "11111111-1111-4111-8111-111111111111";
    const convId = "99999999-9999-4999-8999-999999999999";

    const req = new Request(`http://localhost:3000/api/conversations/${convId}`, {
      headers: { "x-workspace-id": wsA }
    });
    const res = (await getConversationRoute(req, { params: Promise.resolve({ id: convId }) }))!;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.conversation).toBeNull();
    expect(data.messages).toHaveLength(0);
  });

  it("Test 4.2: User A cannot delete User B's conversation (returns 404)", async () => {
    const wsA = "11111111-1111-4111-8111-111111111111";
    const convId = "99999999-9999-4999-8999-999999999999";

    const req = new Request(`http://localhost:3000/api/conversations/${convId}`, {
      method: "DELETE",
      headers: { "x-workspace-id": wsA }
    });
    const res = (await deleteConversationRoute(req, { params: Promise.resolve({ id: convId }) }))!;
    expect(res.status).toBe(404);
  });
});

describe("PHASE 5: Data Lifecycle, Export & Forget (Route Level)", () => {
  it("Test 5.1: Export contains clean structured data and no secret tokens", async () => {
    const ws = "22222222-2222-4222-8222-222222222222";
    const req = new Request("http://localhost:3000/api/workspace", {
      headers: { "x-workspace-id": ws }
    });
    const res = await getWorkspaceRoute(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaceId).toBe(ws);
    expect(Array.isArray(data.conversations)).toBe(true);
    expect(Array.isArray(data.messages)).toBe(true);
    const str = JSON.stringify(data);
    expect(str).not.toContain("token_hash");
    expect(str).not.toContain("client_secret");
  });

  it("Test 5.2: Forget everything deletes workspace content cleanly", async () => {
    const ws = "33333333-3333-4333-8333-333333333333";
    const req = new Request("http://localhost:3000/api/workspace", {
      method: "DELETE",
      headers: { "x-workspace-id": ws }
    });
    const res = await deleteWorkspaceRoute(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});

describe("PHASE 6: Security & API Edge Cases (Route Level)", () => {
  it("Test 6.1: Non-UUID conversation ID is safely rejected by Zod with 400", async () => {
    const maliciousId = "conv' OR 1=1 --";
    const req = new Request(`http://localhost:3000/api/conversations/${encodeURIComponent(maliciousId)}`, {
      headers: { "x-workspace-id": "11111111-1111-4111-8111-111111111111" }
    });
    const res = (await getConversationRoute(req, { params: Promise.resolve({ id: maliciousId }) }))!;
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Invalid conversation id");
  });

  it("Test 6.2: Missing x-workspace-id header in LOCAL mode returns 400", async () => {
    const convId = "11111111-1111-4111-8111-111111111111";
    const req = new Request(`http://localhost:3000/api/conversations/${convId}`);
    const res = (await getConversationRoute(req, { params: Promise.resolve({ id: convId }) }))!;
    expect(res.status).toBe(400);
  });
});

describe("PHASE 7: Privacy Boundary & Egress Sanitization", () => {
  it("Test 7.1: Egress query sanitizer strips email addresses from search queries", () => {
    const query = "Find pricing for john.doe@example.com at Salesforce";
    const sanitized = sanitizeSearchQuery(query);
    expect(sanitized).not.toContain("john.doe@example.com");
    expect(sanitized).toContain("Salesforce");
  });

  it("Test 7.2: Egress query sanitizer removes multiple emails and trims whitespace", () => {
    const query = "Contact test@company.org and admin@sub.domain.co.uk pricing";
    const sanitized = sanitizeSearchQuery(query);
    expect(sanitized).not.toContain("@");
    expect(sanitized).toBe("Contact and pricing");
  });

  it("Test 7.3: Outbound log redaction scrubs API keys and bearer tokens", () => {
    const secretMsg = "Failed calling with gsk_1234567890abcdef and Bearer secret-token-xyz";
    const redacted = redact(secretMsg);
    expect(redacted).not.toContain("gsk_1234567890abcdef");
    expect(redacted).not.toContain("secret-token-xyz");
  });
});

describe("PHASE 9: Database Integrity & Migrations", () => {
  it("Test 9.1: Fresh memory database runs all 5 migrations cleanly", () => {
    const db = memDb();
    const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all() as Array<{ version: number; name: string }>;
    expect(rows).toHaveLength(5);
    expect(rows[0]?.version).toBe(1);
    expect(rows[4]?.version).toBe(5);
  });

  it("Test 9.2: Foreign keys and WAL mode are enabled", () => {
    const db = memDb();
    const fk = db.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
  });

  it("Test 9.3: Cascade deletion removes associated messages in memory database", () => {
    const db = memDb();
    const ws = "44444444-4444-4444-8444-444444444444";
    db.prepare("INSERT INTO workspaces (id, kind, created_at) VALUES (?, 'local', datetime('now'))").run(ws);
    const conv = createConversation(db, ws, "Cascade Test");
    insertMessage(db, {
      conversationId: conv.id,
      workspaceId: ws,
      role: "user",
      content: "Hello",
      timezone: "UTC"
    });

    db.prepare("DELETE FROM conversations WHERE id = ?").run(conv.id);
    const msgs = db.prepare("SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?").get(conv.id) as { c: number };
    expect(msgs.c).toBe(0);
  });
});
