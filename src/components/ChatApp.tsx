"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getWorkspaceId, newId, recallActive, rememberActive, streamChat, userTimeZone } from "./api";
import { MemoryPanel } from "./MemoryPanel";
import { Markdown, MessageItem, PhaseIndicator, RecallBadge } from "./MessageItem";
import type { Conversation, MemorySummary, Message, Phase, Status } from "./types";

interface Pending {
  user: Message;
  memory?: MemorySummary;
  phase: Phase;
  text: string;
  searches: string[];
  requestId: string;
}

const SUGGESTIONS = [
  "What are the best CRM tools for a 20-person sales team? Give me a shortlist of 5 with current pricing.",
  "Compare managed Postgres hosting: Neon, Supabase, AWS RDS and Render — entry pricing.",
  "What did I ask you yesterday?",
  "What changed in the latest Node.js LTS release?",
];

function tempUserMessage(conversationId: string, text: string, tz: string): Message {
  const now = new Date();
  return {
    id: `pending-${now.getTime()}`,
    conversationId,
    role: "user",
    content: text,
    status: "complete",
    createdAtUtc: now.toISOString(),
    timezone: tz,
    localDate: "",
    metadata: {},
    sources: [],
  };
}

export default function ChatApp() {
  // Workspace id lives in localStorage; read once on the client.
  const [ws] = useState<string | null>(() => (typeof window === "undefined" ? null : getWorkspaceId()));
  const [status, setStatus] = useState<Status | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [memoryByUser, setMemoryByUser] = useState<Record<string, MemorySummary>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<{ message: string; missingVar?: string; retryText?: string } | null>(null);
  const [input, setInput] = useState("");
  const [showMemory, setShowMemory] = useState(false);
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);

  const refreshConversations = useCallback(async (workspace: string) => {
    const r = await api.conversations(workspace).catch(() => ({ conversations: [] as Conversation[] }));
    setConversations(r.conversations);
    return r.conversations;
  }, []);

  const loadConversation = useCallback(async (workspace: string, id: string) => {
    const r = await api.conversation(workspace, id).catch(() => null);
    setMessages(r?.messages ?? []);
    setMemoryByUser({});
  }, []);

  // Boot: workspace id from localStorage, then conversations and status.
  useEffect(() => {
    if (!ws) return;
    const id = ws;
    api.status().then(setStatus).catch(() => setStatus({ configured: false, error: "Server unreachable" }));
    api.conversations(id).catch(() => ({ conversations: [] as Conversation[] })).then(({ conversations: list }) => {
      setConversations(list);
      const remembered = recallActive();
      const pick = list.find((c) => c.id === remembered)?.id ?? list[0]?.id ?? null;
      setActiveId(pick);
      if (pick) loadConversation(id, pick);
    });
  }, [ws, loadConversation]);

  useEffect(() => rememberActive(activeId), [activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const selectConversation = (id: string) => {
    if (!ws || pending) return;
    setActiveId(id);
    setError(null);
    setSidebarOpen(false);
    loadConversation(ws, id);
  };

  const newConversation = () => {
    if (pending) return;
    setActiveId(null);
    setMessages([]);
    setMemoryByUser({});
    setError(null);
    setSidebarOpen(false);
    inputRef.current?.focus();
  };

  const send = async (raw: string, requestId = newId()) => {
    const text = raw.trim();
    if (!ws || !text || pending) return;
    const tz = userTimeZone();
    const conversationId = activeId ?? newId();
    if (!activeId) setActiveId(conversationId);
    setInput("");
    setError(null);
    stickToBottom.current = true;
    const p: Pending = { user: tempUserMessage(conversationId, text, tz), phase: "retrieving", text: "", searches: [], requestId };
    setPending(p);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let current = p;
    const update = (patch: Partial<Pending>) => {
      current = { ...current, ...patch };
      setPending(current);
    };
    let finished = false;

    try {
      await streamChat(
        ws,
        { conversationId, text, timeZone: tz, requestId },
        (type, data) => {
          const d = data as Record<string, unknown>;
          if (type === "start") {
            const user = d.userMessage as Message;
            const memory = d.memory as MemorySummary;
            update({ user, memory });
            setMemoryByUser((m) => ({ ...m, [user.id]: memory }));
          } else if (type === "phase") update({ phase: d.phase as Phase });
          else if (type === "search") update({ phase: "searching", searches: d.query ? [...current.searches, String(d.query)] : current.searches });
          else if (type === "delta") update({ phase: "writing", text: current.text + String(d.text) });
          else if (type === "done") {
            finished = true;
            const assistant = d.message as Message;
            const user = current.user;
            setMessages((ms) => (d.replayed ? ms : [...ms, user, assistant]));
            setPending(null);
            refreshConversations(ws);
          } else if (type === "memory") setMemoryRefresh((n) => n + 1);
          else if (type === "error") {
            finished = true;
            setPending(null);
            setError({ message: String(d.message), missingVar: d.missingVar as string | undefined, retryText: d.code === "config" ? undefined : text });
            if (d.code === "config") setInput(text);
            else loadConversation(ws, conversationId);
            refreshConversations(ws);
          }
        },
        ctrl.signal,
      );
      if (!finished) {
        setPending(null);
        setError({ message: "The connection closed before the answer finished.", retryText: text });
        loadConversation(ws, conversationId);
      }
    } catch (e) {
      setPending(null);
      if ((e as Error).name === "AbortError") {
        setTimeout(() => loadConversation(ws, conversationId), 300);
      } else {
        setError({ message: "Could not reach the server.", retryText: text });
      }
    } finally {
      abortRef.current = null;
      inputRef.current?.focus();
    }
  };

  const stop = () => abortRef.current?.abort();

  const commitRename = async (id: string, title: string) => {
    setRenaming(null);
    if (!ws || !title.trim()) return;
    await api.rename(ws, id, title.trim()).catch(() => null);
    refreshConversations(ws);
  };

  const removeConversation = async (id: string) => {
    if (!ws || pending) return;
    if (!window.confirm("Delete this conversation and the memory distilled from it?")) return;
    await api.remove(ws, id).catch(() => null);
    const list = await refreshConversations(ws);
    setMemoryRefresh((n) => n + 1);
    if (id === activeId) {
      const next = list[0]?.id ?? null;
      setActiveId(next);
      if (next) loadConversation(ws, next);
      else setMessages([]);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  };

  const active = conversations.find((c) => c.id === activeId);
  const empty = messages.length === 0 && !pending;

  return (
    <div className={`shell ${showMemory ? "with-memory" : ""}`}>
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`} aria-label="Conversations">
        <div className="brand">
          <span className="logo" aria-hidden>
            m
          </span>
          <div>
            <strong>Minimi</strong>
            <small>research · memory</small>
          </div>
        </div>
        <button className="new-btn" onClick={newConversation} disabled={!!pending}>
          + New conversation
        </button>
        <nav className="conv-list">
          {conversations.length === 0 && <p className="muted pad">No conversations yet.</p>}
          {conversations.map((c) => (
            <div key={c.id} className={`conv ${c.id === activeId ? "active" : ""}`}>
              {renaming === c.id ? (
                <input
                  autoFocus
                  defaultValue={c.title}
                  aria-label="Conversation title"
                  onBlur={(e) => commitRename(c.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(c.id, (e.target as HTMLInputElement).value);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <button className="conv-main" onClick={() => selectConversation(c.id)} onDoubleClick={() => setRenaming(c.id)} title={c.title}>
                  <span className="conv-title">{c.title}</span>
                  <span className="conv-date">{new Date(c.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                </button>
              )}
              <div className="conv-actions">
                <button className="icon-btn" onClick={() => setRenaming(c.id)} aria-label={`Rename ${c.title}`}>
                  ✎
                </button>
                <button className="icon-btn" onClick={() => removeConversation(c.id)} aria-label={`Delete ${c.title}`}>
                  🗑
                </button>
              </div>
            </div>
          ))}
        </nav>
        <footer className="side-foot">
          {status && (
            <span className={`status ${status.configured ? "ok" : "bad"}`}>
              <span className="led" aria-hidden />
              {status.configured ? `${status.provider} · ${status.model}` : "API key not configured"}
            </span>
          )}
        </footer>
      </aside>
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} aria-hidden />}

      <main className="chat">
        <header className="topbar">
          <button className="icon-btn menu" onClick={() => setSidebarOpen(true)} aria-label="Open conversations">
            ☰
          </button>
          <h1>{active?.title ?? "New conversation"}</h1>
          <button className={`mem-toggle ${showMemory ? "on" : ""}`} onClick={() => setShowMemory((v) => !v)} aria-pressed={showMemory}>
            Memory
          </button>
        </header>

        <div className="scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="thread">
            {empty && (
              <section className="welcome">
                <h2>
                  Ask anything. <em>I’ll remember when you asked.</em>
                </h2>
                <p>
                  Minimi searches the web when facts may have changed, cites its sources, and keeps a dated record of every question — so you can come back
                  later and ask <q>has any of that changed since?</q>
                </p>
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send(s)} disabled={!!pending}>
                      {s}
                    </button>
                  ))}
                </div>
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
                    <time>{new Date(pending.user.createdAtUtc).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
                  </header>
                  {pending.memory && <RecallBadge memory={pending.memory} />}
                  <div className="msg-body">
                    <p className="plain">{pending.user.content}</p>
                  </div>
                </article>
                <article className="msg assistant streaming" aria-busy="true">
                  <header className="msg-head">
                    <span className="who">Minimi</span>
                  </header>
                  {(pending.phase !== "writing" || pending.searches.length > 0) && <PhaseIndicator phase={pending.phase} searches={pending.searches} />}
                  {pending.text && (
                    <div className="msg-body">
                      <Markdown text={pending.text.replace(/【[^】]*】/g, "")} />
                      <span className="caret" aria-hidden />
                    </div>
                  )}
                </article>
              </>
            )}
            {error && (
              <div className="alert" role="alert">
                {error.missingVar ? (
                  <>
                    <strong>Setup needed.</strong> Add <code>{error.missingVar}</code> to <code>.env.local</code> in the project folder, then restart{" "}
                    <code>npm run dev</code>. {error.missingVar === "GEMINI_API_KEY" && <>A free key is available at aistudio.google.com/apikey.</>}
                    {error.missingVar === "GROQ_API_KEY" && <>A free key is available at console.groq.com/keys.</>}
                  </>
                ) : (
                  <>
                    <span>{error.message}</span>
                    {error.retryText && (
                      <button className="link-btn" onClick={() => send(error.retryText!)}>
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
            send(input);
          }}
        >
          <label htmlFor="prompt" className="sr-only">
            Message
          </label>
          <textarea
            id="prompt"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={status && !status.configured ? `Set ${status.missingVar ?? "an API key"} to start chatting…` : "Ask a question, or “has any of that changed since?”"}
            rows={1}
            maxLength={8000}
            autoFocus
          />
          {pending ? (
            <button type="button" className="send stop" onClick={stop} aria-label="Stop generating">
              ■
            </button>
          ) : (
            <button type="submit" className="send" disabled={!input.trim()} aria-label="Send message">
              ↑
            </button>
          )}
        </form>
        <p className="hint">Enter to send · Shift+Enter for a new line · times shown in your local timezone</p>
      </main>

      {showMemory && ws && (
        <MemoryPanel
          workspaceId={ws}
          refreshKey={memoryRefresh}
          onClose={() => setShowMemory(false)}
          onOpenConversation={(id) => {
            selectConversation(id);
          }}
        />
      )}
    </div>
  );
}
