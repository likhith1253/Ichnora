"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import { shortDate } from "./format";
import { Skeleton } from "./LoopsView";
import { PersonalItem, type ItemActions } from "./PersonalItem";
import type { MemoryItem, MemoryView as MV } from "./types";
import { usePersonal } from "./usePersonal";

const ABOUT_TYPES = new Set(["FACT", "PREFERENCE", "RELATIONSHIP", "PROJECT"]);
const TYPE_LABEL: Record<string, string> = {
  FACT: "Fact",
  PREFERENCE: "Preference",
  RELATIONSHIP: "Person",
  PROJECT: "Project",
  shortlist: "Shortlist",
  comparison: "Comparison",
  research_snapshot: "Snapshot",
  decision: "Decision",
  constraint: "Constraint",
  open_question: "Open question",
  topic: "Topic",
};

function DecisionTimeline({ subject, entries, actions }: { subject: string; entries: MV[]; actions: ItemActions }) {
  const sorted = [...entries].sort((a, b) => a.memory.eventDate.localeCompare(b.memory.eventDate) || a.memory.createdAt.localeCompare(b.memory.createdAt));
  return (
    <li className="timeline">
      <h3>{subject}</h3>
      <ol>
        {sorted.map(({ memory: m }) => {
          const current = m.status === "ACTIVE";
          const label = m.status === "SUPERSEDED" ? "superseded" : m.status === "CONSIDERING" ? "considering" : m.kind === "rejected" ? "rejected" : current ? "current" : m.status.toLowerCase();
          return (
            <li key={m.id} className={`step${current ? " current" : ""}${m.status === "SUPERSEDED" ? " superseded" : ""}`}>
              <div className="step-head">
                <time>{shortDate(m.eventDate)}</time>
                <span className="step-state">{label}</span>
              </div>
              <p className="step-text">{m.content}</p>
              {m.rationale && <p className="step-why">Why: {m.rationale}</p>}
              {m.alternatives.length > 0 && <p className="step-why">Also considered: {m.alternatives.join(", ")}</p>}
              {m.quote && <p className="step-quote">“{m.quote}”</p>}
              <div className="step-actions">
                <button type="button" className="link-btn" onClick={() => actions.onOpenConversation(m.conversationId)}>
                  Open conversation
                </button>
                <button
                  type="button"
                  className="link-btn danger"
                  onClick={() => {
                    if (window.confirm(`Delete “${m.content}”?`)) actions.onDelete(m.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </li>
  );
}

function Snapshots({ ws, refreshKey, onOpenConversation, filter }: { ws: string; refreshKey: number; onOpenConversation: (id: string) => void; filter: string }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .memory(ws)
      .then((r) => live && setItems(r.items))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [ws, refreshKey]);

  const forget = async (id: string) => {
    if (!window.confirm("Forget this research snapshot? Later “has it changed?” questions will have no baseline.")) return;
    await api.forget(ws, id).catch(() => null);
    setItems((xs) => xs?.filter((x) => x.id !== id) ?? null);
  };

  const q = filter.trim().toLowerCase();
  const shown = (items ?? []).filter((m) => !q || `${m.title} ${m.summary} ${m.entities.join(" ")}`.toLowerCase().includes(q));

  return (
    <section className="group" aria-labelledby="g-research">
      <header className="group-head">
        <h2 id="g-research">
          Research snapshots <span className="count">{items?.length ?? 0}</span>
        </h2>
        <p>Dated records of what the web said — the baseline for “has anything changed since?”.</p>
      </header>
      {error && <p className="notice error">{error}</p>}
      {items === null && !error && <Skeleton />}
      {items?.length === 0 && <p className="group-empty">No research yet. Ask about prices, tools or releases and a dated snapshot is kept here.</p>}
      <ul className="cards">
        {shown.map((m) => (
          <li key={m.id} className="card">
            <div className="card-top">
              <span className="kind">{TYPE_LABEL[m.type] ?? m.type}</span>
              <time>{shortDate(m.baselineDate)}</time>
            </div>
            <h3>{m.title}</h3>
            <p>{m.summary}</p>
            {m.entities.length > 0 && <p className="ents">{m.entities.slice(0, 10).join(" · ")}</p>}
            {m.facts.length > 0 && (
              <details>
                <summary>{m.facts.length} recorded facts</summary>
                <table className="facts">
                  <tbody>
                    {m.facts.slice(0, 40).map((f, i) => (
                      <tr key={i}>
                        <th scope="row">{f.entity}</th>
                        <td>{f.attribute}</td>
                        <td>{f.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
            <div className="card-actions">
              <button type="button" className="link-btn" onClick={() => onOpenConversation(m.conversationId)}>
                Open conversation
              </button>
              <button type="button" className="link-btn danger" onClick={() => forget(m.id)}>
                Forget
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MemoryView({ ws, refreshKey, onOpenConversation }: { ws: string; refreshKey: number; onOpenConversation: (id: string) => void }) {
  const { data, error, patch, remove } = usePersonal(ws, refreshKey);
  const [filter, setFilter] = useState("");
  const actions: ItemActions = { onPatch: patch, onDelete: remove, onOpenConversation };
  const q = filter.trim().toLowerCase();
  const match = (v: MV) => !q || `${v.memory.subject} ${v.memory.content} ${v.memory.quote}`.toLowerCase().includes(q);

  const views = (data?.items ?? []).filter(match);
  const about = views.filter((v) => ABOUT_TYPES.has(v.memory.type) && v.memory.status !== "SUPERSEDED");
  const decisions = new Map<string, MV[]>();
  for (const v of views.filter((x) => x.memory.type === "DECISION")) {
    const key = v.memory.subject || "General";
    decisions.set(key, [...(decisions.get(key) ?? []), v]);
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Memory</h1>
        <p>Everything Minimi keeps, with your own words and when you said them. Correct or delete anything.</p>
      </header>
      <label className="search-field">
        <span className="sr-only">Filter memory</span>
        <input type="search" placeholder="Filter memory" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      {error && <p className="notice error">{error}</p>}

      <section className="group" aria-labelledby="g-about">
        <header className="group-head">
          <h2 id="g-about">
            About you <span className="count">{about.length}</span>
          </h2>
          <p>Facts, preferences, people and projects you’ve mentioned.</p>
        </header>
        {!data && !error ? (
          <Skeleton />
        ) : about.length === 0 ? (
          <p className="group-empty">{q ? "No matches." : "Nothing yet. Mention a preference or a fact about your work and it appears here."}</p>
        ) : (
          <ul className="items">
            {about.map((v) => (
              <li key={v.memory.id} className="item-wrap">
                <span className="kind">{TYPE_LABEL[v.memory.type] ?? v.memory.type}</span>
                <ul className="items flush">
                  <PersonalItem m={v.memory} today={data!.today} actions={actions} showDue={false} allowEditText />
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="group" aria-labelledby="g-decisions">
        <header className="group-head">
          <h2 id="g-decisions">
            Decisions <span className="count">{decisions.size}</span>
          </h2>
          <p>How each choice evolved. Earlier steps stay visible, marked superseded.</p>
        </header>
        {!data && !error ? (
          <Skeleton />
        ) : decisions.size === 0 ? (
          <p className="group-empty">{q ? "No matches." : "No decisions recorded. Say “we chose Postgres over Mongo because…” and the reasoning is kept."}</p>
        ) : (
          <ul className="timelines">
            {[...decisions.entries()].map(([subject, entries]) => (
              <DecisionTimeline key={subject} subject={subject} entries={entries} actions={actions} />
            ))}
          </ul>
        )}
      </section>

      <Snapshots ws={ws} refreshKey={refreshKey} onOpenConversation={onOpenConversation} filter={filter} />
    </div>
  );
}
