# Architecture verification — identity, demo, and the local-first boundary

Status: **CASE A — the implementation follows the intended local-first,
cloud-assisted architecture.** One data-minimisation gap was found and fixed
during this review (see *Deviations*), and no rewrite is required. All existing
features are preserved; `npm run check` (typecheck, lint, 217 tests, production
build) and `npm run eval` (20/20) pass.

This document verifies the code **as it is on disk**, not the documentation.
File references point at the exact modules inspected.

---

## 1. Intended architecture

- **Local-first, cloud-assisted.** Persistent personal memory lives in a local
  SQLite database. The cloud is used only for *selected* work, never as the
  storage layer: Groq for inference, Tavily for public web research, OAuth
  providers for identity.
- **Separation of concerns:** storage (local) · inference (external, selective)
  · search (external, selective) · authentication (external, identity only) ·
  authorization (local, enforced on the server).
- **No cloud persistence / no automatic sync.** No Supabase, Firebase, hosted
  Postgres, cloud vector store, or remote memory upload.
- **Authentication establishes identity only.** Sessions are stored locally with
  hashed tokens; OAuth access tokens are not persisted; minimal scopes.

---

## 2. What the implementation actually does

| Concern | Where | Behaviour |
|---|---|---|
| Persistent storage | [schema.ts](file:///d:/minimi/src/lib/db/schema.ts), [index.ts](file:///d:/minimi/src/lib/db/index.ts) | One local SQLite file (better-sqlite3, WAL, `foreign_keys=ON`), forward-only migrations v1–v5. Every table is scoped by `workspace_id`. |
| Dependency surface | [package.json](file:///d:/minimi/package.json) | Runtime deps are only `better-sqlite3, next, openai, react, react-dom, react-markdown, remark-gfm, zod`. No cloud DB / sync SDK. |
| Workspace resolution | [identity.ts](file:///d:/minimi/src/lib/server/identity.ts) | Single function `resolveWorkspace(req, db, cfg)` decides the workspace for every API route. |
| Sessions | [sessions.ts](file:///d:/minimi/src/lib/auth/sessions.ts), [tokens.ts](file:///d:/minimi/src/lib/auth/tokens.ts) | Server-side rows; only `SHA-256(token)` is stored (`token_hash`). Expiry, rotation, revoke, and expired-row cleanup. |
| Cookies | [cookies.ts](file:///d:/minimi/src/lib/auth/cookies.ts), [flow.ts](file:///d:/minimi/src/lib/auth/flow.ts) | `HttpOnly; SameSite=Lax; Path=/; Max-Age=…`, `Secure` in production. Two cookies: `minimi_session`, short-lived `minimi_oauth`. |
| OAuth flow | [providers.ts](file:///d:/minimi/src/lib/auth/providers.ts), [login/route](file:///d:/minimi/src/app/api/auth/login/route.ts), [callback route](file:///d:/minimi/src/app/api/auth/callback/[provider]/route.ts) | Authorization-code **+ PKCE (S256)** + signed `state`. GitHub (`read:user user:email`), Google (`openid email profile`). Userinfo is fetched with the access token, which is then discarded. |
| CSRF | [csrf.ts](file:///d:/minimi/src/lib/auth/csrf.ts) | Same-origin (Origin, Referer fallback) required on non-idempotent requests in AUTH mode and for demo. LOCAL mode has no ambient credential, so it keeps header-only behaviour. |
| Accounts / workspaces | [accounts.ts](file:///d:/minimi/src/lib/auth/accounts.ts) | `users`, `oauth_accounts` (unique `provider, provider_user_id`), plus `workspaces.owner_user_id`, `kind`. |
| Demo | [demo/](file:///d:/minimi/src/lib/demo), [demo route](file:///d:/minimi/src/app/api/demo/route.ts) | Guest user owns one `kind='demo'` workspace, seeded deterministically; per-session budgets; per-IP rate limit; answer cache; TTL cleanup on startup + every 10 min. |
| Inference context | [prompt.ts](file:///d:/minimi/src/lib/agent/prompt.ts), [context.ts](file:///d:/minimi/src/lib/memory/context.ts) | Retrieval picks turns/memories **locally**; the rendered context is capped at `MAX_CONTEXT_CHARS = 6_500` (~2.3K tokens) and treated as untrusted data. |
| Search egress | [tavily.ts](file:///d:/minimi/src/lib/search/tavily.ts), [sanitize.ts](file:///d:/minimi/src/lib/search/sanitize.ts) | Every outbound search/extract query passes `sanitizeSearchQuery` (strips emails, normalises whitespace). |
| Data portability | [export.ts](file:///d:/minimi/src/lib/server/export.ts) | Export is the workspace's own rows + optional non-secret account metadata. No tokens exist in the DB to leak. |
| Logs | [log.ts](file:///d:/minimi/src/lib/server/log.ts) | `redact()` scrubs Groq/Tavily/OpenAI/Google keys, bearer tokens and generic `api_key`/`token` fields. |

---

## 3. Requirements satisfied

**Local storage (source of truth).** All personal state — conversations,
messages, memories, facts, preferences, commitments/open loops, decisions,
entities, research topics/snapshots/observations, source provenance,
user/workspace associations, sessions — is in SQLite. No remote persistence, no
sync, and nothing personal is pushed to GitHub (only source code is).

**Inference is selective.** Context is assembled locally by
`retrieve()` and bounded; the model sees only the turns/memories retrieval
selected, never the whole database. The model is not claimed to run on-device.

**Search is selective and sanitised.** Recall/date/"what did I ask" intents set
`toolChoice: "none"`, so no search fires. Live research queries are stripped of
identity tokens before leaving the machine; history answerable locally does not
trigger search.

**Authentication is identity-only.** Minimal scopes; the access token is used
once for userinfo and never stored; `oauth_accounts` stores only
`provider`, `provider_user_id`, `email`. No access to the user's repos/Google
data. Sessions are local, hashed, rotating, revocable.

**Modes.** LOCAL mode needs no OAuth config and behaves exactly as before
(header-based, no sign-in screen). AUTH mode activates only when a provider *and*
`AUTH_SECRET` are configured; then the workspace comes **only** from the session
and `x-workspace-id` is ignored.

**Demo.** Isolated `kind='demo'` workspace; seeded through the app's own storage
functions (repo / personal store / research ledger), labelled synthetic in the
UI; per-session turn+credit budgets, per-IP creation limit, cached suggested
answers, TTL expiry and cleanup. Seeding refuses any non-demo workspace.

**Honest crypto posture.** SQLite is **not** encrypted at rest (see §5).

---

## 4. Deviations

1. **Search-query data minimisation was missing — fixed.** The model-drafted
   Tavily query was sent verbatim. Added
   [sanitize.ts](file:///d:/minimi/src/lib/search/sanitize.ts) and applied it at
   both egress points in [tavily.ts](file:///d:/minimi/src/lib/search/tavily.ts)
   (`search()` and `extract()`); a pure-identity query now makes no network call.
   Covered by four tests in `tests/groq-tavily.test.ts`. No public-research
   behaviour changed.

No other deviations: no cloud persistence, no sync, no unnecessary scopes, no
access-token persistence, and workspace ownership is derived from the session on
the server.

---

## 5. Security & privacy assessment

**Checked and correct**

- **Session tokens** — only `sha256` stored; rotation issues a fresh token and
  deletes the old row (fixation-resistant); expiry deletes the row; sign-out
  revokes idempotently.
- **Cookies** — `HttpOnly`, `SameSite=Lax`, `Secure` in production, bounded
  `Max-Age` so the cookie cannot outlive the session.
- **CSRF** — same-origin required on state-changing requests in AUTH mode (and
  demo creation); safe methods exempt.
- **Open redirects** — `safeInternalPath()` rejects `//`, `/\`, backslashes and
  CR/LF; used in the login `next` and after the callback.
- **IDOR / cross-user access** — AUTH ignores `x-workspace-id`; the workspace is
  `resolveOwnedWorkspace(session.userId, session.kind)`. Tests prove A cannot
  read, modify, export or delete B's data on chat/conversations/memory/personal/
  workspace routes.
- **Workspace claiming** — `claimWorkspace` only attaches a workspace that is
  `owner_user_id IS NULL AND kind = 'local'`, and only to the session's own user;
  an already-owned workspace can never be claimed.
- **Account deletion** — `users` deletion cascades to `oauth_accounts`,
  `sessions` and owned `workspaces`, which in turn cascade to every derived row.
- **Demo isolation** — seed guard + `kind='demo'` scoping; demo never appears in
  a non-demo workspace (tested).
- **Demo quota safety** — turn and credit budgets per session, cached answers,
  per-IP creation limit, plus TTL cleanup.
- **Secrets in logs** — `redact()` applied on the callback error path; provider
  keys/tokens never logged by the app.

**Risks / limitations (documented, not hidden)**

- **SQLite is not encrypted at rest.** Confidentiality relies on OS file
  permissions and full-disk encryption. A DB-file leak exposes memory. A
  passphrase key (SQLCipher) or OS-level encryption would be required for
  at-rest encryption; not introduced here (key management, migration, recovery
  and perf trade-offs are out of scope for this phase).
- **A `local`/`demo` workspace id is a bearer capability.** Until claimed, a
  workspace is reached by its random UUID. This matches the existing single-user
  trust model; it is not a multi-tenant network security boundary. AUTH mode
  removes this for signed-in users because the id is never taken from the client.
- **LOCAL mode is single-user.** It applies no CSRF check and trusts the header;
  it must not be exposed as a shared/multi-user deployment.
- **Remote hosting caveat.** If the app is ever hosted remotely, SQLite lives on
  the *host*, not on each user's device — that is not "local to the end user".
- **External providers.** Groq processes the selected inference context and
  Tavily processes sanitised search queries. We minimise what is sent; we do not
  claim zero-retention or on-device processing (Groq ZDR and Tavily retention are
  account/policy settings we do not control from here).
- **Demo releases** — `addCredits` accounts for search + extracted pages;

**Required corrections from this review:** none outstanding (the single
search-egress gap is fixed and tested).

---

## 6. Features that must remain unchanged

The single `web_search` model tool; Groq (`openai/gpt-oss-120b`) and Tavily as
providers; the SQLite-first design and migrations v1–v4; LOCAL-mode behaviour and
all regression tests; the existing Git author identity; no AI co-author
attribution. None of these were altered by this phase.

---

## 7. Decision

**CASE A.** The implementation is local-first and cloud-assisted as intended.
The one deviation (unsanitised search egress) was corrected in place and covered
by tests. Existing functionality is preserved and all checks pass. Work
continues on the original authentication + Try Demo requirements; no rewrite, no
re-clone, no history changes.
