"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { DemoPrompt } from "./api";
import { timeOnly } from "./format";
import { Markdown, MessageItem, PhaseIndicator, RecallBadge } from "./MessageItem";
import type { MemorySummary, Message, Phase, Status } from "./types";

export interface Pending {
  user: Message;
  memory?: MemorySummary;
  phase: Phase;
  text: string;
  searches: string[];
  requestId: string;
}

export interface ChatError {
  message: string;
  missingVar?: string;
  retry?: { text: string; requestId: string };
}

export interface Notice {
  id: string;
  text: string;
}

const SUGGESTIONS = [
  { label: "Research", text: "Compare managed Postgres hosting: Neon, Supabase, AWS RDS and Render — entry pricing." },
  { label: "Commit", text: "I'll send the pricing proposal to Rahul by Friday." },
  { label: "Recall", text: "What did I ask you yesterday?" },
  { label: "Verify", text: "Has any of that pricing changed since I last asked?" },
];

export function ChatView({
  title,
  status,
  messages,
  loading,
  memoryByUser,
  pending,
  error,
  notices,
  input,
  inputRef,
  onInput,
  onSend,
  onStop,
  onDismissNotice,
  onOpenLoops,
  demoPrompts,
}: {
  title?: string;
  status: Status | null;
  messages: Message[];
  loading: boolean;
  memoryByUser: Record<string, MemorySummary>;
  pending: Pending | null;
  error: ChatError | null;
  notices: Notice[];
  input: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onInput: (v: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onDismissNotice: (id: string) => void;
  onOpenLoops: () => void;
  demoPrompts?: DemoPrompt[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const empty = messages.length === 0 && !pending && !loading;
  const demo = Boolean(demoPrompts?.length);
  const suggestions = demo
    ? demoPrompts!.map((p) => ({ id: p.id, label: p.label, text: p.text, hint: p.hint }))
    : SUGGESTIONS.map((s) => ({ id: s.text, label: s.label, text: s.text, hint: undefined as string | undefined }));

  useEffect(() => {
    const el = scrollRef.current;
    if (pending && !pending.text && pending.phase === "retrieving") stick.current = true;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending, notices, error]);

  // Auto-grow the composer.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input, inputRef]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend(input);
    }
  };

  const notConfigured = status && !status.configured;

  return (
    <div className="chat">
      <div className="scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="thread">
          {title && !empty && <h1 className="thread-title">{title}</h1>}
          {notConfigured && (
            <div className="notice setup" role="status">
              <strong>Setup needed.</strong> Add <code>{status.missingVar ?? "GROQ_API_KEY"}</code> to <code>.env.local</code> in the project folder, then send a
              message (no restart needed). {(status.missingVar ?? "GROQ_API_KEY") === "GROQ_API_KEY" && <>Free keys: console.groq.com/keys.</>}
              {status.error && <span className="muted"> {status.error}</span>}
            </div>
          )}
          {status?.configured && !status.searchConfigured && (
            <div className="notice" role="status">
              <strong>Web search is off.</strong> Add <code>TAVILY_API_KEY</code> to <code>.env.local</code> (free at tavily.com). Memory and recall still work;
              current facts will be marked unverified.
            </div>
          )}
          {loading && messages.length === 0 && (
            <div className="skeleton" role="status" aria-live="polite">
              <span className="sr-only">Loading conversation…</span>
              <div />
              <div />
            </div>
          )}
          {empty && (
            <section className="welcome" aria-labelledby="welcome-h">
              <p className="eyebrow">{demo ? "Demo · guided tour" : "Ichnora"}</p>
              <h2 id="welcome-h">{demo ? "A seeded workspace, ready to explore." : "Remember the past. Discover the present."}</h2>
              <p>
                {demo
                  ? "Sample conversations from the last week are already here. Pick one to see date recall, a freshness re-check, a computed change report, open loops and a decision history — all from Ichnora’s own memory."
                  : "Ichnora connects your conversations, memories, decisions and live web research into one searchable personal knowledge system."}
              </p>
              <ul className="suggestions">
                {suggestions.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => onSend(s.text)} disabled={!!pending || !!notConfigured}>
                      <span className="sg-label">{s.label}</span>
                      <span>{s.text}</span>
                      {s.hint && <span className="sg-hint">{s.hint}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {messages.map((m) => (
            <MessageItem key={m.id} message={m} memory={memoryByUser[m.id]} />
          ))}
          {pending && (
            <>
              <article className="msg user">
                <header className="msg-head">
                  <span className="who">You</span>
                  <time dateTime={pending.user.createdAtUtc}>{timeOnly(pending.user.createdAtUtc)}</time>
                </header>
                {pending.memory && <RecallBadge memory={pending.memory} />}
                <div className="msg-body">
                  <p className="plain">{pending.user.content}</p>
                </div>
              </article>
              <article className="msg assistant streaming" aria-busy="true">
                <header className="msg-head">
                  <span className="who">Ichnora</span>
                </header>
                {(pending.phase !== "writing" || !pending.text) && <PhaseIndicator phase={pending.phase} searches={pending.searches} />}
                {pending.phase === "writing" && pending.text && (
                  <p className="sr-only" role="status" aria-live="polite">
                    Writing answer…
                  </p>
                )}
                {pending.text && (
                  <div className="msg-body">
                    <Markdown text={pending.text.replace(/【[^】]*】/g, "")} />
                    <span className="caret" aria-hidden />
                  </div>
                )}
              </article>
            </>
          )}
          <div className="notices" aria-live="polite">
            {notices.map((n) => (
              <div key={n.id} className="toast">
                <span>{n.text}</span>
                <button type="button" className="link-btn" onClick={onOpenLoops}>
                  View
                </button>
                <button type="button" className="icon-btn small" onClick={() => onDismissNotice(n.id)} aria-label="Dismiss">
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                    <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          {error && (
            <div className="notice error" role="alert">
              {error.missingVar ? (
                <>
                  <strong>Setup needed.</strong> Add <code>{error.missingVar}</code> to <code>.env.local</code> and send your message again (no restart needed).{" "}
                  {error.missingVar === "GROQ_API_KEY" && <>Free keys: console.groq.com/keys.</>}
                </>
              ) : (
                <>
                  <span>{error.message}</span>
                  {error.retry && (
                    <button type="button" className="btn small" onClick={() => onSend(error.retry!.text)}>
                      Retry
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          onSend(input);
        }}
      >
        <div className="composer-box">
          <label htmlFor="prompt" className="sr-only">
            Message
          </label>
          <textarea
            id="prompt"
            ref={inputRef}
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={notConfigured ? `Add ${status.missingVar ?? "an API key"} to start…` : "Ask, tell Ichnora what you’ve promised, or ask what changed…"}
            rows={1}
            maxLength={8000}
            autoFocus
          />
          {pending ? (
            <button type="button" className="send stop" onClick={onStop} aria-label="Stop generating">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <rect x="1" y="1" width="10" height="10" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button type="submit" className="send" disabled={!input.trim()} aria-label="Send message">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        <p className="hint">Enter to send · Shift+Enter for a new line · times in your local timezone</p>
      </form>
    </div>
  );
}
