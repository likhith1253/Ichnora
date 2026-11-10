"use client";

import { useEffect, useRef, useState } from "react";
import { api, downloadExport } from "./api";

/** Privacy controls: export everything, or forget everything. */
export function SettingsMenu({ ws, onForgotten }: { ws: string | null; onForgotten: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "export" | "forget">(null);
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
          <p className="popover-note">Stored only in this app’s local database, keyed to this browser.</p>
          <button type="button" className="menu-item" onClick={exportData} disabled={!!busy} autoFocus>
            <strong>{busy === "export" ? "Preparing…" : "Export my data"}</strong>
            <span>Download everything as JSON</span>
          </button>
          <button type="button" className="menu-item danger" onClick={forget} disabled={!!busy}>
            <strong>{busy === "forget" ? "Forgetting…" : "Forget everything"}</strong>
            <span>Permanently delete this workspace</span>
          </button>
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
