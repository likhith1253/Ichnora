"use client";

import { useEffect, useState } from "react";
import { identity, type Me } from "./api";
import { IchnoraMark } from "./IchnoraMark";

const ERRORS: Record<string, string> = {
  state: "That sign-in attempt expired or could not be verified. Please try again.",
  denied: "Sign-in was cancelled, or the provider did not return a code.",
  exchange: "We could not complete the sign-in with the provider. Please try again.",
};

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

function nextPath(): string {
  const n = new URLSearchParams(window.location.search).get("next");
  if (!n) return "/";
  if (!n.startsWith("/") || n.startsWith("//") || n.includes("\\") || n.includes("\r") || n.includes("\n")) return "/";
  return n;
}

/**
 * The sign-in screen shown only in AUTH mode. Providers are offered as plain
 * links into the OAuth flow; "Try the demo" works even with no provider set up.
 */
export function SignIn() {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const code = new URLSearchParams(window.location.search).get("error");
    return code ? (ERRORS[code] ?? "Sign-in failed. Please try again.") : null;
  });

  useEffect(() => {
    identity
      .me()
      .then((m) => {
        setMe(m);
        // Local mode needs no sign-in; an existing account or demo continues straight in.
        if (m.mode === "local" || m.signedIn || m.demo) window.location.replace(nextPath());
      })
      .catch(() => setMe({ mode: "local", signedIn: false, user: null, demo: false, providers: [], demoEnabled: false }));
  }, []);

  const tryDemo = async () => {
    setBusy(true);
    setErr(null);
    try {
      await identity.startDemo();
      window.location.assign(nextPath());
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const providers = me?.providers ?? [];
  const hasGithub = providers.includes("github");
  const hasGoogle = providers.includes("google");
  const anyProvider = hasGithub || hasGoogle;

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand auth-brand">
          <IchnoraMark size={28} />
          <span className="brand-name">Ichnora</span>
        </div>
        <p className="eyebrow">Remember the past. Discover the present.</p>
        <h1>Sign in to keep your work</h1>
        <p className="auth-lede">Ichnora connects your conversations, memories, decisions and live web research into one searchable personal knowledge system.</p>

        {err && (
          <div className="notice error" role="alert">
            {err}
          </div>
        )}

        <div className="auth-actions">
          {hasGithub && (
            <a className="btn auth-btn" href={identity.providerHref("github", nextPath())}>
              <GitHubMark />
              Continue with GitHub
            </a>
          )}
          {hasGoogle && (
            <a className="btn auth-btn" href={identity.providerHref("google", nextPath())}>
              <GoogleMark />
              Continue with Google
            </a>
          )}
        </div>

        {me?.demoEnabled && (
          <>
            {anyProvider && (
              <div className="auth-sep" role="separator">
                <span>or</span>
              </div>
            )}
            <button type="button" className="btn auth-btn demo-btn" onClick={tryDemo} disabled={busy}>
              {busy ? "Preparing the demo…" : "Try the demo"}
            </button>
            <p className="auth-note">A disposable, seeded workspace. No account, nothing saved.</p>
          </>
        )}

        {me && !anyProvider && (
          <p className="auth-note">
            No sign-in provider is configured. Add <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> to <code>.env.local</code> to enable GitHub
            sign-in.
          </p>
        )}
      </div>
    </main>
  );
}
