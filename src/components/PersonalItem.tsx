"use client";

import { useState } from "react";
import { dayLabel, daysBetween, relativeDue, shortDate } from "./format";
import type { PersonalMemory, PersonalPatch } from "./types";

export interface ItemActions {
  onPatch: (id: string, patch: PersonalPatch) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onOpenConversation: (id: string) => void;
}

const CLOSED = new Set(["COMPLETED", "CANCELLED", "SUPERSEDED"]);

/** One remembered statement: what, the user's own words, when, and corrections. */
export function PersonalItem({
  m,
  today,
  actions,
  showDue = true,
  allowEditText = false,
}: {
  m: PersonalMemory;
  today: string;
  actions: ItemActions;
  showDue?: boolean;
  allowEditText?: boolean;
}) {
  const [mode, setMode] = useState<"view" | "due" | "text">("view");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const closed = CLOSED.has(m.status);
  const overdue = !closed && m.dueDate && daysBetween(today, m.dueDate) < 0;
  const isLoop = ["COMMITMENT", "ACTION_ITEM", "FOLLOW_UP"].includes(m.type) || m.status === "WAITING";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setMode("view");
    } finally {
      setBusy(false);
    }
  };

  const who = m.status === "WAITING" ? m.counterparty ?? m.owner : m.counterparty;

  return (
    <li className={`item${overdue ? " overdue" : ""}${closed ? " closed" : ""}`}>
      <div className="item-main">
        <p className="item-text">
          {m.status === "COMPLETED" && <span className="sr-only">Done: </span>}
          {m.content}
        </p>
        <div className="item-meta">
          {showDue && m.dueDate && <span className={`due${overdue ? " is-overdue" : ""}`}>{closed ? `was due ${dayLabel(m.dueDate)}` : `${relativeDue(today, m.dueDate)} · ${dayLabel(m.dueDate)}`}</span>}
          {showDue && !m.dueDate && isLoop && !closed && <span className="due none">No due date stated</span>}
          {who && <span>{m.status === "WAITING" ? `Waiting on ${who}` : `With ${who}`}</span>}
          {closed && <span>{m.status === "COMPLETED" ? "Done" : m.status === "CANCELLED" ? "Cancelled" : "Superseded"}</span>}
          {m.evidence !== "explicit" && <span title="Not stated outright — inferred from what you said">inferred</span>}
          {m.userCorrected && <span>edited by you</span>}
          {m.mentionCount > 1 && <span>mentioned {m.mentionCount}×</span>}
        </div>
        {m.quote && (
          <blockquote className="quote">
            <p>“{m.quote}”</p>
            <footer>
              you said, {shortDate(m.eventDate)} ·{" "}
              <button type="button" className="link-btn" onClick={() => actions.onOpenConversation(m.conversationId)}>
                open conversation
              </button>
            </footer>
          </blockquote>
        )}
        {mode === "due" && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => actions.onPatch(m.id, { dueDate: draft || null }));
            }}
          >
            <label>
              <span className="sr-only">Due date</span>
              <input type="date" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
            </label>
            <button type="submit" className="btn small" disabled={busy}>
              Save
            </button>
            <button type="button" className="btn small ghost" onClick={() => setMode("view")}>
              Cancel
            </button>
          </form>
        )}
        {mode === "text" && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim().length >= 2) run(() => actions.onPatch(m.id, { content: draft.trim() }));
            }}
          >
            <label className="grow">
              <span className="sr-only">Correct this memory</span>
              <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={400} autoFocus />
            </label>
            <button type="submit" className="btn small" disabled={busy || draft.trim().length < 2}>
              Save
            </button>
            <button type="button" className="btn small ghost" onClick={() => setMode("view")}>
              Cancel
            </button>
          </form>
        )}
      </div>
      {mode === "view" && (
        <div className="item-actions" aria-label="Actions">
          {!closed && isLoop && (
            <button type="button" className="btn small" disabled={busy} onClick={() => run(() => actions.onPatch(m.id, { status: "COMPLETED" }))}>
              Mark done
            </button>
          )}
          {!closed && isLoop && (
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => run(() => actions.onPatch(m.id, { status: "CANCELLED" }))}>
              Cancel
            </button>
          )}
          {closed && isLoop && (
            <button
              type="button"
              className="btn small ghost"
              disabled={busy}
              onClick={() => run(() => actions.onPatch(m.id, { status: m.counterparty && m.kind === "waiting" ? "WAITING" : "OPEN" }))}
            >
              Reopen
            </button>
          )}
          {!closed && isLoop && (
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                setDraft(m.dueDate ?? "");
                setMode("due");
              }}
            >
              {m.dueDate ? "Edit due date" : "Add due date"}
            </button>
          )}
          {allowEditText && !closed && (
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                setDraft(m.content);
                setMode("text");
              }}
            >
              Correct
            </button>
          )}
          <button
            type="button"
            className="btn small ghost danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete “${m.content}”? Ichnora will stop remembering it.`)) run(() => actions.onDelete(m.id));
            }}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
}
