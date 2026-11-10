"use client";

import { useState } from "react";
import type { Conversation, Status } from "./types";

export function Sidebar({
  open,
  conversations,
  activeId,
  busy,
  status,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onClose,
}: {
  open: boolean;
  conversations: Conversation[];
  activeId: string | null;
  busy: boolean;
  status: Status | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);

  const commit = (id: string, title: string) => {
    setRenaming(null);
    onRename(id, title);
  };

  const ok = !!status?.configured;
  const search = !!status?.searchConfigured;

  return (
    <>
      <aside className={`rail${open ? " open" : ""}`} aria-label="Conversations">
        <div className="brand">
          <span className="mark-logo" aria-hidden>
            m
          </span>
          <span className="brand-name">Minimi</span>
          <button type="button" className="icon-btn rail-close" onClick={onClose} aria-label="Close menu">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        <button type="button" className="new-btn" onClick={onNew} disabled={busy}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          New conversation
        </button>
        <nav className="conv-list" aria-label="Conversation history">
          {conversations.length === 0 && <p className="rail-empty">Your conversations will be listed here, with the day you had them.</p>}
          <ul>
            {conversations.map((c) => (
              <li key={c.id} className={`conv${c.id === activeId ? " active" : ""}`}>
                {renaming === c.id ? (
                  <input
                    className="conv-rename"
                    autoFocus
                    defaultValue={c.title}
                    aria-label="Conversation title"
                    onBlur={(e) => commit(c.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit(c.id, (e.target as HTMLInputElement).value);
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="conv-main"
                    onClick={() => onSelect(c.id)}
                    onDoubleClick={() => setRenaming(c.id)}
                    aria-current={c.id === activeId ? "page" : undefined}
                    disabled={busy && c.id !== activeId}
                  >
                    <span className="conv-title">{c.title}</span>
                    <span className="conv-date">{new Date(c.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                  </button>
                )}
                <div className="conv-actions">
                  <button type="button" className="icon-btn" onClick={() => setRenaming(c.id)} aria-label={`Rename “${c.title}”`}>
                    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                      <path d="M2 12h2.5L12 4.5 9.5 2 2 9.5V12z" fill="none" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                  </button>
                  <button type="button" className="icon-btn" onClick={() => onDelete(c.id)} aria-label={`Delete “${c.title}”`} disabled={busy}>
                    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                      <path d="M2.5 4h9M5.5 4V2.5h3V4M3.5 4l.7 8h5.6l.7-8" fill="none" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </nav>
        <footer className="rail-foot" aria-live="polite">
          {!status ? (
            <span className="st">Connecting…</span>
          ) : (
            <>
              <span className={`st${ok ? "" : " off"}`}>
                <span className="led" aria-hidden />
                {ok ? status.model ?? "Model ready" : `${status.missingVar ?? "Model"} not set`}
              </span>
              <span className={`st${search ? "" : " off"}`}>
                <span className="led" aria-hidden />
                Web search {search ? "on" : "off"}
              </span>
            </>
          )}
        </footer>
      </aside>
      {open && <div className="scrim" onClick={onClose} aria-hidden />}
    </>
  );
}
