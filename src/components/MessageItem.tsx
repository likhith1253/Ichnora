"use client";

import { memo } from "react";
import { ChangeCard } from "./ChangeCard";
import { dateTime, dayLabel, shortDate } from "./format";
import { Markdown } from "./Markdown";
import type { MemorySummary, Message, MessageMetadata, Phase, Source } from "./types";

export { Markdown };

function Sources({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  const verified = sources.filter((s) => s.origin !== "answer_link");
  const unverified = sources.filter((s) => s.origin === "answer_link");
  const ordered = [...verified, ...unverified];
  return (
    <details className="sources" open={verified.length > 0 && verified.length <= 5}>
      <summary>
        <span>Sources</span>
        <span className="count">{verified.length}</span>
        {unverified.length > 0 && <span className="count warn">{unverified.length} unverified</span>}
      </summary>
      <ol>
        {ordered.map((s, i) => {
          const n = s.sourceNo ?? i + 1;
          const unv = s.origin === "answer_link";
          return (
            <li key={s.url} className={unv ? "unverified" : ""}>
              <span className="src-no" aria-hidden>
                {n}
              </span>
              <div className="src-body">
                <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.snippet ?? undefined}>
                  <span className="sr-only">Source {n}: </span>
                  {s.title || s.domain}
                </a>
                <div className="src-meta">
                  <span>{s.domain}</span>
                  {s.official ? <span className="mark official">Official</span> : !unv && <span className="mark">Third-party</span>}
                  {!unv && <span className="mark">{s.evidenceLevel === "full_page" ? "Full page read" : "Snippet only"}</span>}
                  {s.publishedDate && <span>Published {shortDate(s.publishedDate)}</span>}
                  {unv && <span className="mark warn">Linked by model · not verified by search</span>}
                </div>
                {s.query && <div className="src-query">via “{s.query}”</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function EvidenceLine({ meta, sources }: { meta: MessageMetadata; sources: Source[] }) {
  const parts: string[] = [];
  if (typeof meta.factualClaims === "number" && meta.factualClaims > 0) parts.push(`${meta.citedClaims ?? 0}/${meta.factualClaims} factual claims cited`);
  if (meta.pagesRead) parts.push(`${meta.pagesRead} ${meta.pagesRead === 1 ? "page" : "pages"} read in full`);
  if (meta.pagesFailed) parts.push(`${meta.pagesFailed} unreadable`);
  const official = sources.filter((s) => s.official && s.origin !== "answer_link").length;
  if (official) parts.push(`${official} official`);
  if (meta.searchQueries?.length) parts.push(`${meta.searchQueries.length} ${meta.searchQueries.length === 1 ? "search" : "searches"}`);
  if (parts.length === 0) return null;
  const weak = typeof meta.claimCoverage === "number" && meta.claimCoverage < 0.5;
  return (
    <p className={`evidence${weak ? " weak" : ""}`} title={meta.searchQueries?.join(" · ")}>
      {parts.join(" · ")}
    </p>
  );
}

export function RecallBadge({ memory }: { memory: MemorySummary }) {
  const chips: string[] = [];
  for (const d of memory.dateHits) {
    const range = d.start === d.end ? dayLabel(d.start, true) : `${dayLabel(d.start)} – ${dayLabel(d.end, true)}`;
    chips.push(d.found > 0 ? `“${d.phrase}” = ${range} · ${d.found} saved ${d.found === 1 ? "question" : "questions"}` : `“${d.phrase}” = ${range} · nothing saved`);
  }
  if (memory.referent) chips.push(`Following up “${memory.referent.title.slice(0, 60)}” from ${shortDate(memory.referent.baselineDate)}`);
  if (memory.ambiguous.length > 1) chips.push(`${memory.ambiguous.length} possible topics — will ask which`);
  if (memory.noMemoryFound && memory.dateHits.every((d) => d.found > 0)) chips.push("No matching memory found");
  if (chips.length === 0 && memory.relatedCount > 0) chips.push(`${memory.relatedCount} related ${memory.relatedCount === 1 ? "memory" : "memories"} consulted`);
  if (chips.length === 0) return null;
  return (
    <ul className="recall" aria-label="Memory used for this answer">
      {chips.map((c) => (
        <li key={c}>{c}</li>
      ))}
    </ul>
  );
}

const PHASE_TEXT: Record<Phase, string> = {
  retrieving: "Checking memory",
  thinking: "Thinking",
  searching: "Searching the web",
  writing: "Writing",
};

export function PhaseIndicator({ phase, searches }: { phase: Phase; searches: string[] }) {
  return (
    <div className="phase" role="status" aria-live="polite">
      <span className="phase-line">
        <span className={`pulse p-${phase}`} aria-hidden />
        {PHASE_TEXT[phase]}…
      </span>
      {searches.length > 0 && (
        <ul className="queries" aria-label="Search queries">
          {searches.slice(-4).map((q, i) => (
            <li key={`${q}-${i}`}>{q}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const INTENT_LABEL: Record<string, string> = {
  recall: "Answered from memory",
  open_loops: "From your open loops",
  decision_history: "From your decision history",
  clarify: "Asking to clarify",
};

function Provenance({ meta }: { meta: MessageMetadata }) {
  const bits: string[] = [];
  if (meta.intent === "recall_and_verify") bits.push(meta.searchUnavailable ? "Memory re-check (web unavailable)" : "Memory, re-checked on the web");
  else if (meta.intent && INTENT_LABEL[meta.intent]) bits.push(INTENT_LABEL[meta.intent]!);
  else if (meta.searched) bits.push("Checked on the web");
  if (meta.searchUnavailable && meta.intent !== "recall_and_verify") bits.push("Web search unavailable — not verified");
  if (bits.length === 0) return null;
  return <span className={`prov${meta.searchUnavailable ? " warn" : ""}`}>{bits.join(" · ")}</span>;
}

export const MessageItem = memo(function MessageItem({ message, memory }: { message: Message; memory?: MemorySummary }) {
  const isUser = message.role === "user";
  const meta = message.metadata ?? {};
  return (
    <article className={`msg ${message.role}${message.status !== "complete" ? ` ${message.status}` : ""}`}>
      <header className="msg-head">
        <span className="who">{isUser ? "You" : "Minimi"}</span>
        <time dateTime={message.createdAtUtc} title={`Captured in ${message.timezone}`}>
          {dateTime(message.createdAtUtc)}
        </time>
        {!isUser && <Provenance meta={meta} />}
        {message.status === "cancelled" && <span className="prov">Stopped</span>}
      </header>
      {isUser && memory && <RecallBadge memory={memory} />}
      <div className="msg-body">{isUser ? <p className="plain">{message.content}</p> : <Markdown text={message.content} sources={message.sources} />}</div>
      {!isUser && meta.changeReport && <ChangeCard report={meta.changeReport} />}
      {!isUser && <EvidenceLine meta={meta} sources={message.sources} />}
      {!isUser && <Sources sources={message.sources} />}
    </article>
  );
});
