"use client";

import { useEffect, useRef, useState } from "react";
import { api, downloadExport, type Me } from "./api";

/** Privacy and account controls: export, forget, sign out, delete account. */
export function SettingsMenu({
  ws,
  me,
  onForgotten,
  onSignOut,
  onDeleteAccount,
  onTryDemo,
}: {
  ws: string | null;
  me?: Me | null;
  onForgotten: () => void;
  onSignOut?: () => void;
  onDeleteAccount?: () => void;
  onTryDemo?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "export" | "forget" | "delete">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const exportData = async () => {
    if (!ws) return;
    setBusy("export");
    setMsg(null);
    try {
      await downloadExport(ws);
      setMsg("Export downloaded.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    if (!window.confirm("Forget everything? All conversations, personal memory and research snapshots in this workspace are permanently deleted. This cannot be undone.")) return;
    if (!ws) return;
    setBusy("forget");
    try {
      await api.forgetEverything(ws);
      setOpen(false);
      onForgotten();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async () => {
    if (!onDeleteAccount) return;
    if (!window.confirm("Delete your account? Your workspaces, conversations and memory will be permanently deleted. This cannot be undone.")) return;
    setBusy("delete");
    try {
      await onDeleteAccount();
    } catch (e) {
      setMsg((e as Error).message);
      setBusy(null);
    }
  };

  const signedIn = Boolean(me?.signedIn && me.user);

  return (
    <div className="settings" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className="btn ghost small"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="privacy-menu"
        onClick={() => setOpen((v) => !v)}
      >
        Your data
      </button>
      {open && (
        <div id="privacy-menu" className="popover" role="group" aria-label="Your data">
          {signedIn && me?.user && (
            <div className="menu-account">
              <strong>{me.user.name ?? me.user.email ?? "Signed in"}</strong>
              {me.user.name && me.user.email && <span>{me.user.email}</span>}
            </div>
          )}
          <p className="popover-note">
            {me?.demo
              ? "Stored in this app’s local database, as a disposable demo workspace."
              : signedIn
                ? "Stored in this app’s local database, attached to your account."
                : "Stored only in this app’s local database, keyed to this browser."}
          </p>
          <button type="button" className="menu-item" onClick={exportData} disabled={!!busy} autoFocus>
            <strong>{busy === "export" ? "Preparing…" : "Export my data"}</strong>
            <span>Download everything as JSON</span>
          </button>
          <button type="button" className="menu-item danger" onClick={forget} disabled={!!busy}>
            <strong>{busy === "forget" ? "Forgetting…" : "Forget everything"}</strong>
            <span>Permanently delete this workspace</span>
          </button>
          {!signedIn && !me?.demo && me?.demoEnabled && onTryDemo && (
            <button type="button" className="menu-item" onClick={onTryDemo} disabled={!!busy}>
              <strong>Try the demo</strong>
              <span>A seeded, disposable example workspace</span>
            </button>
          )}
          {signedIn && (
            <>
              <div className="popover-divider" />
              <button type="button" className="menu-item" onClick={onSignOut} disabled={!!busy}>
                <strong>Sign out</strong>
                <span>End this session on this device</span>
              </button>
              <button type="button" className="menu-item danger" onClick={deleteAccount} disabled={!!busy}>
                <strong>{busy === "delete" ? "Deleting…" : "Delete account"}</strong>
                <span>Permanently delete your account and all its data</span>
              </button>
            </>
          )}
          {msg && (
            <p className="popover-note" role="status">
              {msg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
