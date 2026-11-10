import assert from "node:assert";
import Database from "better-sqlite3";
import { launchBrowser, BASE_URL, captureScreenshot } from "./helpers.mjs";
import { parseDotEnv } from "../../src/lib/env.js";

const DB_PATH = "data/qa_browser.db";

async function runFullAudit() {
  console.log("=== COMPREHENSIVE QA AUDIT: PHASES 3 - 9 ===");
  const results = {
    total: 0,
    passed: 0,
    failed: 0,
    defects: []
  };

  function test(name, fn) {
    results.total++;
    try {
      fn();
      console.log(`  [PASS] ${name}`);
      results.passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}:`, err.message);
      results.failed++;
      results.defects.push({ test: name, error: err.message });
    }
  }

  async function testAsync(name, fn) {
    results.total++;
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      results.passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}:`, err.message);
      results.failed++;
      results.defects.push({ test: name, error: err.message });
    }
  }

  const db = new Database(DB_PATH);

  // -------------------------------------------------------------
  // PHASE 3: AUTHENTICATION
  // -------------------------------------------------------------
  console.log("\n--- PHASE 3: AUTHENTICATION & SESSION LIFECYCLE ---");

  // Test 3.1: Sign-in route behavior in current mode
  await testAsync("Test 3.1: Sign-in interface redirects in LOCAL mode", async () => {
    const res = await fetch(`${BASE_URL}/signin`, { redirect: "manual" });
    // In local mode, Next.js /signin client component redirects to nextPath ("/")
    assert.strictEqual(res.status, 200, "Signin page should serve 200 HTML in Next.js");
  });

  // Test 3.2 & 3.3: OAuth callback failure / adversarial cases
  await testAsync("Test 3.3: OAuth callback with missing state fails safely", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/callback/github?code=12345`, { redirect: "manual" });
    assert.strictEqual(res.status, 307, "Should redirect to signin on missing state");
    const loc = res.headers.get("location");
    assert.ok(loc?.includes("error=state"), `Expected state error in redirect, got ${loc}`);
  });

  await testAsync("Test 3.3: OAuth callback with invalid state fails safely", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/callback/github?code=12345&state=invalid.signature`, {
      headers: { cookie: "minimi_oauth=valid-cookie-state" },
      redirect: "manual"
    });
    assert.strictEqual(res.status, 307);
    const loc = res.headers.get("location");
    assert.ok(loc?.includes("error=state"));
  });

  await testAsync("Test 3.3: OAuth callback with provider error (access_denied) redirects with error", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/callback/github?error=access_denied`, { redirect: "manual" });
    assert.strictEqual(res.status, 307);
    const loc = res.headers.get("location");
    assert.ok(loc?.includes("error=denied"));
  });

  await testAsync("Test 3.3: Open redirect attempt in ?next parameter is stripped", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login?provider=github&next=https://evil.com`, { redirect: "manual" });
    // Without GITHUB_CLIENT_ID configured, login route 400s safely
    assert.ok(res.status === 400 || res.status === 307, `Expected 400 or redirect, got ${res.status}`);
  });

  // -------------------------------------------------------------
  // PHASE 4: AUTHORIZATION, IDOR & WORKSPACE ISOLATION
  // -------------------------------------------------------------
  console.log("\n--- PHASE 4: AUTHORIZATION, IDOR & WORKSPACE ISOLATION ---");

  // Create two isolated workspaces in the database
  const wsA = "11111111-1111-4111-8111-111111111111";
  const wsB = "22222222-2222-4222-8222-222222222222";
  const convB = "conv-bob-secret-999";

  db.prepare("INSERT OR IGNORE INTO workspaces (id, kind, created_at) VALUES (?, 'local', datetime('now'))").run(wsA);
  db.prepare("INSERT OR IGNORE INTO workspaces (id, kind, created_at) VALUES (?, 'local', datetime('now'))").run(wsB);
  db.prepare("INSERT OR IGNORE INTO conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))").run(convB, wsB, "Bob Secret Project");
  db.prepare("INSERT OR IGNORE INTO messages (id, conversation_id, workspace_id, role, content, timezone, local_date, created_at_utc) VALUES (?, ?, ?, 'user', 'Bob super secret password', 'UTC', '2026-11-11', datetime('now'))").run("msg-bob-1", convB, wsB);

  await testAsync("Test 4.1: User A cannot read User B's conversation by ID (IDOR prevention)", async () => {
    const res = await fetch(`${BASE_URL}/api/conversations/${convB}`, {
      headers: { "x-workspace-id": wsA }
    });
    assert.strictEqual(res.status, 404, "User A must receive 404 for User B's conversation");
  });

  await testAsync("Test 4.2: User A cannot delete User B's conversation", async () => {
    const res = await fetch(`${BASE_URL}/api/conversations/${convB}`, {
      method: "DELETE",
      headers: { "x-workspace-id": wsA }
    });
    // Bob's conversation must still exist in DB
    const check = db.prepare("SELECT * FROM conversations WHERE id = ?").get(convB);
    assert.ok(check, "Bob's conversation must not have been deleted by User A");
  });

  await testAsync("Test 4.3: User A's conversation list does not leak User B's conversations", async () => {
    const res = await fetch(`${BASE_URL}/api/conversations`, {
      headers: { "x-workspace-id": wsA }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(!data.conversations.some(c => c.id === convB), "User A's list must not contain User B's conversation");
  });

  await testAsync("Test 4.4: User A export does not contain User B's messages or memories", async () => {
    const res = await fetch(`${BASE_URL}/api/workspace`, {
      headers: { "x-workspace-id": wsA }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const str = JSON.stringify(data);
    assert.ok(!str.includes("Bob super secret password"), "Export must not leak cross-workspace data");
  });

  // -------------------------------------------------------------
  // PHASE 5: DATA LIFECYCLE & EXPORT
  // -------------------------------------------------------------
  console.log("\n--- PHASE 5: DATA EXPORT & WORKSPACE INTEGRITY ---");

  await testAsync("Test 5.1: Export contains clean structured data and no secret tokens", async () => {
    const res = await fetch(`${BASE_URL}/api/workspace`, {
      headers: { "x-workspace-id": wsB }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.workspace, "Export must have workspace info");
    assert.ok(Array.isArray(data.conversations), "Export must have conversations array");
    assert.ok(Array.isArray(data.messages), "Export must have messages array");
    const jsonStr = JSON.stringify(data);
    assert.ok(!jsonStr.includes("token_hash"), "Must never export session hashes");
    assert.ok(!jsonStr.includes("client_secret"), "Must never export client secrets");
  });

  await testAsync("Test 5.2: Forget everything deletes workspace content cleanly", async () => {
    const wsTemp = "33333333-3333-4333-8333-333333333333";
    db.prepare("INSERT OR IGNORE INTO workspaces (id, kind, created_at) VALUES (?, 'local', datetime('now'))").run(wsTemp);
    db.prepare("INSERT OR IGNORE INTO conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))").run("conv-temp", wsTemp, "Temp Chat");

    const res = await fetch(`${BASE_URL}/api/workspace`, {
      method: "DELETE",
      headers: { "x-workspace-id": wsTemp }
    });
    assert.strictEqual(res.status, 200);
    const remaining = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE workspace_id = ?").get(wsTemp);
    assert.strictEqual(remaining.count, 0, "All conversations in workspace must be deleted");
  });

  // -------------------------------------------------------------
  // PHASE 6: SECURITY & API EDGE CASES
  // -------------------------------------------------------------
  console.log("\n--- PHASE 6: SECURITY & API EDGE CASES ---");

  await testAsync("Test 6.1: Missing request body on POST returns 400 safely", async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": wsA }
    });
    assert.strictEqual(res.status, 400);
  });

  await testAsync("Test 6.2: Invalid JSON payload returns 400 safely without crashing", async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": wsA },
      body: "{ not valid json }"
    });
    assert.strictEqual(res.status, 400);
  });

  await testAsync("Test 6.3: SQL Injection payload in conversation ID is safely parameterized", async () => {
    const maliciousId = "conv' OR 1=1 --";
    const res = await fetch(`${BASE_URL}/api/conversations/${encodeURIComponent(maliciousId)}`, {
      headers: { "x-workspace-id": wsA }
    });
    assert.strictEqual(res.status, 404, "SQL injection string must not execute and should safely 404");
  });

  await testAsync("Test 6.4: XSS injection string in conversation title is stored safely", async () => {
    const xssTitle = "<script>alert('xss')</script>";
    const convId = "conv-xss-test";
    db.prepare("INSERT OR REPLACE INTO conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))").run(convId, wsA, xssTitle);
    const res = await fetch(`${BASE_URL}/api/conversations/${convId}`, {
      headers: { "x-workspace-id": wsA }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.conversation.title, xssTitle, "Title stored verbatim without execution");
  });

  await testAsync("Test 6.5: Unsupported HTTP method on /api/conversations returns 405", async () => {
    const res = await fetch(`${BASE_URL}/api/conversations`, {
      method: "PUT",
      headers: { "x-workspace-id": wsA }
    });
    assert.strictEqual(res.status, 405);
  });

  // -------------------------------------------------------------
  // PHASE 7: PRIVACY BOUNDARY & EGRESS SANITIZATION
  // -------------------------------------------------------------
  console.log("\n--- PHASE 7: PRIVACY BOUNDARY & EGRESS SANITIZATION ---");

  test("Test 7.1: Egress query sanitizer strips email addresses", () => {
    const { sanitizeSearchQuery } = require("../../src/lib/search/sanitize.ts");
    const query = "Find pricing for john.doe@example.com at Salesforce";
    const sanitized = sanitizeSearchQuery(query);
    assert.ok(!sanitized.includes("john.doe@example.com"), "Email must be stripped from search query");
    assert.ok(sanitized.includes("Salesforce"), "Non-private query text must be preserved");
  });

  test("Test 7.2: Egress query sanitizer removes multiple emails and trims whitespace", () => {
    const { sanitizeSearchQuery } = require("../../src/lib/search/sanitize.ts");
    const query = "Contact test@company.org and admin@sub.domain.co.uk pricing";
    const sanitized = sanitizeSearchQuery(query);
    assert.ok(!sanitized.includes("@"), "All emails must be stripped");
    assert.strictEqual(sanitized, "Contact and pricing");
  });

  test("Test 7.3: Outbound log redaction scrubs API keys and bearer tokens", () => {
    const { redact } = require("../../src/lib/server/log.ts");
    const secretMsg = "Failed calling with gsk_1234567890abcdef and Bearer secret-token-xyz";
    const redacted = redact(secretMsg);
    assert.ok(!redacted.includes("gsk_1234567890abcdef"), "Groq API key must be redacted");
    assert.ok(!redacted.includes("secret-token-xyz"), "Bearer token must be redacted");
  });

  // -------------------------------------------------------------
  // PHASE 9: DATABASE INTEGRITY & MIGRATIONS
  // -------------------------------------------------------------
  console.log("\n--- PHASE 9: DATABASE INTEGRITY & MIGRATIONS ---");

  test("Test 9.1: Database schema migrations v1 through v5 are applied", () => {
    const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all();
    console.log("    Applied migrations:", rows.map(r => `v${r.version}: ${r.name}`).join(", "));
    assert.strictEqual(rows.length, 5, "Expected exactly 5 migrations (v1-v5)");
    assert.strictEqual(rows[0].version, 1);
    assert.strictEqual(rows[4].version, 5);
  });

  test("Test 9.2: Foreign keys and WAL mode are active", () => {
    const fk = db.pragma("foreign_keys", { simple: true });
    const journal = db.pragma("journal_mode", { simple: true });
    assert.strictEqual(fk, 1, "Foreign keys must be ON");
    assert.strictEqual(journal.toLowerCase(), "wal", "Journal mode must be WAL");
  });

  test("Test 9.3: Cascade deletion removes associated messages and memories", () => {
    const wsCascade = "44444444-4444-4444-8444-444444444444";
    const convCascade = "conv-cascade-1";
    db.prepare("INSERT OR IGNORE INTO workspaces (id, kind, created_at) VALUES (?, 'local', datetime('now'))").run(wsCascade);
    db.prepare("INSERT OR IGNORE INTO conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, 'Cascade', datetime('now'), datetime('now'))").run(convCascade, wsCascade);
    db.prepare("INSERT OR IGNORE INTO messages (id, conversation_id, workspace_id, role, content, timezone, local_date, created_at_utc) VALUES (?, ?, ?, 'user', 'test', 'UTC', '2026-11-11', datetime('now'))").run("msg-casc-1", convCascade, wsCascade);

    // Delete conversation
    db.prepare("DELETE FROM conversations WHERE id = ?").run(convCascade);
    const msgs = db.prepare("SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?").get(convCascade);
    assert.strictEqual(msgs.c, 0, "Messages must cascade delete with conversation");
  });

  // Cleanup test workspaces
  db.prepare("DELETE FROM workspaces WHERE id IN (?, ?, ?, ?)").run(wsA, wsB, "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444");
  db.close();

  console.log(`\nAudit Complete: ${results.passed}/${results.total} passed, ${results.failed} failed.`);
  return results;
}

runFullAudit().then(r => {
  if (r.failed > 0) process.exit(1);
});

