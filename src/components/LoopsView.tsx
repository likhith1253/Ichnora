"use client";

import { dayLabel, daysBetween } from "./format";
import { PersonalItem, type ItemActions } from "./PersonalItem";
import type { PersonalMemory } from "./types";
import { usePersonal } from "./usePersonal";

function Group({
  title,
  note,
  items,
  today,
  actions,
  empty,
}: {
  title: string;
  note?: string;
  items: PersonalMemory[];
  today: string;
  actions: ItemActions;
  empty: string;
}) {
  const id = `g-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section className="group" aria-labelledby={id}>
      <header className="group-head">
        <h2 id={id}>
          {title} <span className="count">{items.length}</span>
        </h2>
        {note && <p>{note}</p>}
      </header>
      {items.length === 0 ? (
        <p className="group-empty">{empty}</p>
      ) : (
        <ul className="items">
          {items.map((m) => (
            <PersonalItem key={m.id} m={m} today={today} actions={actions} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function LoopsView({ ws, refreshKey, onOpenConversation }: { ws: string; refreshKey: number; onOpenConversation: (id: string) => void }) {
  const { data, error, patch, remove } = usePersonal(ws, refreshKey);
  const actions: ItemActions = { onPatch: patch, onDelete: remove, onOpenConversation };

  if (!data) {
    return (
      <div className="view">
        <ViewHead />
        {error ? <p className="notice error">{error}</p> : <Skeleton />}
      </div>
    );
  }

  const { loops, today } = data;
  const byDue = (a: PersonalMemory, b: PersonalMemory) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
  const commitments = [...loops.open].sort(byDue);
  const overdue = [...loops.open, ...loops.waiting].filter((m) => m.dueDate && daysBetween(today, m.dueDate) < 0).length;
  const soon = loops.dueSoon.length;
  const total = loops.open.length + loops.waiting.length + loops.considering.length + loops.recentlyClosed.length;

  return (
    <div className="view">
      <ViewHead today={today} />
      {error && <p className="notice error">{error}</p>}
      {total === 0 ? (
        <div className="empty-state">
          <h2>Nothing open.</h2>
          <p>
            When you tell Ichnora things like <q>I’ll send the proposal to Rahul by Friday</q> or <q>waiting on Priya for the contract</q>, they land here
            with your exact words and the date you said them.
          </p>
        </div>
      ) : (
        <>
          <p className="summary" aria-live="polite">
            {overdue > 0 ? <strong className="text-danger">{overdue} overdue</strong> : "Nothing overdue"}
            {" · "}
            {soon} due in the next 7 days · {loops.waiting.length} waiting on others
          </p>
          <Group title="Commitments" note="Things you said you would do." items={commitments} today={today} actions={actions} empty="No open commitments." />
          <Group title="Waiting on others" note="Things other people owe you." items={loops.waiting} today={today} actions={actions} empty="Not waiting on anyone." />
          <Group
            title="Tentative intentions"
            note="Hedged — “maybe”, “thinking about”. Not promises, so never counted as overdue."
            items={loops.considering}
            today={today}
            actions={actions}
            empty="No tentative intentions."
          />
          <Group title="Recently closed" note="Done or cancelled in the last 14 days." items={loops.recentlyClosed} today={today} actions={actions} empty="Nothing closed recently." />
        </>
      )}
    </div>
  );
}

function ViewHead({ today }: { today?: string }) {
  return (
    <header className="view-head">
      <h1>Open loops</h1>
      <p>Commitments taken from your own messages{today ? ` · today is ${dayLabel(today, true)}` : ""}.</p>
    </header>
  );
}

export function Skeleton() {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div />
      <div />
      <div />
    </div>
  );
}
