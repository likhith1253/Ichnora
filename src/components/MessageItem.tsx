"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MemorySummary, Message, Phase, Source } from "./types";

const timeFmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const dateFmt = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function safeHref(href?: string): string | undefined {
  if (!href) return undefined;
  return /^https?:\/\//i.test(href) ? href : undefined;
}

/** Raw HTML is never rendered (react-markdown default); links are http(s) only. */
const mdComponents: Components = {
  a: ({ href, children }) => {
    const safe = safeHref(href);
    if (!safe) return <span>{children}</span>;
    let host = "";
    try {
      host = new URL(safe).hostname.replace(/^www\./, "");
    } catch {
      /* keep empty */
    }
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow" className="cite" title={host}>
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents} skipHtml>
      {text}
    </ReactMarkdown>
  );
});

function Sources({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  const verified = sources.filter((s) => s.origin !== "answer_link");
  const unverified = sources.filter((s) => s.origin === "answer_link");
  return (
    <details className="sources" open={verified.length <= 6}>
      <summary>
        <span className="sources-label">Sources</span>
        <span className="pill">{verified.length}</span>
        {unverified.length > 0 && <span className="pill warn" title="Linked in the answer but not returned by web search">{unverified.length} unverified</span>}
      </summary>
      <ol>
        {[...verified, ...unverified].map((s) => (
          <li key={s.url} className={s.origin === "answer_link" ? "unverified" : s.origin === "citation" ? "cited" : ""}>
            <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">
              <span className="mono" aria-hidden>
                {s.domain.charAt(0).toUpperCase()}
              </span>
              <span className="src-title">{s.title || s.domain}</span>
              <span className="src-domain">{s.domain}</span>
            </a>
            {s.origin === "answer_link" && <span className="src-flag">not from search results</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function RecallBadge({ memory }: { memory: MemorySummary }) {
  const chips: string[] = [];
  for (const d of memory.dateHits) {
    const range = d.start === d.end ? dateFmt(d.start) : `${dateFmt(d.start)} – ${dateFmt(d.end)}`;
    chips.push(d.found > 0 ? `“${d.phrase}” → ${range} · ${d.found} saved ${d.found === 1 ? "question" : "questions"}` : `“${d.phrase}” → ${range} · nothing saved`);
  }
  if (memory.referent) chips.push(`Following up: ${memory.referent.title.slice(0, 60)} (${dateFmt(memory.referent.baselineDate)})`);
  if (memory.ambiguous.length > 1) chips.push(`${memory.ambiguous.length} possible topics — will ask`);
  if (memory.noMemoryFound && memory.dateHits.every((d) => d.found > 0)) chips.push("No matching memory found");
  if (chips.length === 0 && memory.relatedCount > 0) chips.push(`${memory.relatedCount} related memories`);
  if (chips.length === 0) return null;
  return (
    <div className="recall" aria-label="Memory used for this answer">
      <span className="recall-icon" aria-hidden>
        ↺
      </span>
      {chips.map((c) => (
        <span key={c} className="recall-chip">
          {c}
        </span>
      ))}
    </div>
  );
}

const PHASE_TEXT: Record<Phase, string> = {
  retrieving: "Checking memory…",
  thinking: "Thinking…",
  searching: "Searching the web…",
  writing: "Writing answer…",
};

export function PhaseIndicator({ phase, searches }: { phase: Phase; searches: string[] }) {
  return (
    <div className="phase" role="status" aria-live="polite">
      <span className={`dot ${phase}`} aria-hidden />
      <span>{PHASE_TEXT[phase]}</span>
      {searches.length > 0 && (
        <span className="queries">
          {searches.slice(-3).map((q, i) => (
            <span key={`${q}-${i}`} className="query">
              ⌕ {q}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

export const MessageItem = memo(function MessageItem({ message, memory }: { message: Message; memory?: MemorySummary }) {
  const isUser = message.role === "user";
  return (
    <article className={`msg ${message.role} ${message.status !== "complete" ? message.status : ""}`}>
      <header className="msg-head">
        <span className="who">{isUser ? "You" : "Minimi"}</span>
        <time dateTime={message.createdAtUtc} title={`${message.createdAtUtc} UTC · captured in ${message.timezone}`}>
          {timeFmt(message.createdAtUtc)}
        </time>
        {!isUser && message.metadata.searched && <span className="tag search">web checked</span>}
        {!isUser && message.metadata.intent === "recall" && <span className="tag mem">from memory</span>}
        {!isUser && message.metadata.intent === "recall_and_verify" && <span className="tag mem">memory + web re-check</span>}
      </header>
      {isUser && memory && <RecallBadge memory={memory} />}
      <div className="msg-body">{isUser ? <p className="plain">{message.content}</p> : <Markdown text={message.content} />}</div>
      {!isUser && <Sources sources={message.sources} />}
    </article>
  );
});
