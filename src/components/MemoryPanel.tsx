"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import type { MemoryItem } from "./types";

const dateFmt = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const TYPE_LABEL: Record<string, string> = {
  shortlist: "Shortlist",
  comparison: "Comparison",
  research_snapshot: "Snapshot",
  decision: "Decision",
  constraint: "Constraint",
  open_question: "Open question",
  topic: "Topic",
};

export function MemoryPanel({
  workspaceId,
  refreshKey,
  onClose,
  onOpenConversation,
}: {
  workspaceId: string;
  refreshKey: number;
  onClose: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let live = true;
    api
      .memory(workspaceId)
      .then((r) => live && setItems(r.items))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [workspaceId, refreshKey]);

  const forget = async (id: string) => {
    await api.forget(workspaceId, id).catch(() => null);
    setItems((xs) => xs?.filter((x) => x.id !== id) ?? null);
  };

  const q = filter.trim().toLowerCase();
  const shown = (items ?? []).filter((m) => !q || `${m.title} ${m.summary} ${m.entities.join(" ")}`.toLowerCase().includes(q));

  return (
    <aside className="memory" aria-label="Memory inspector">
      <header>
        <div>
          <h2>Memory</h2>
          <p className="muted">What Minimi distilled from your conversations. Original messages are always kept verbatim.</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close memory inspector">
          ✕
        </button>
      </header>
      <input className="filter" placeholder="Filter memory…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter memory" />
      {error && <p className="error-text">{error}</p>}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted empty">Nothing remembered yet. Research a topic and its shortlist, prices and dates will appear here.</p>}
      <ul>
        {shown.map((m) => (
          <li key={m.id} className="mem-card">
            <div className="mem-top">
              <span className={`mem-type t-${m.type}`}>{TYPE_LABEL[m.type] ?? m.type}</span>
              <time>{dateFmt(m.baselineDate)}</time>
            </div>
            <h3>{m.title}</h3>
            <p>{m.summary}</p>
            {m.entities.length > 0 && (
              <div className="ents">
                {m.entities.slice(0, 12).map((e) => (
                  <span key={e}>{e}</span>
                ))}
              </div>
            )}
            {m.facts.length > 0 && (
              <details>
                <summary>{m.facts.length} recorded facts</summary>
                <ul className="facts">
                  {m.facts.slice(0, 30).map((f, i) => (
                    <li key={i}>
                      <b>{f.entity}</b> · {f.attribute}: {f.value}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="mem-actions">
              <button className="link-btn" onClick={() => onOpenConversation(m.conversationId)}>
                Open conversation
              </button>
              <button className="link-btn danger" onClick={() => forget(m.id)}>
                Forget
              </button>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
