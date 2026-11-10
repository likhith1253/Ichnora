"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getWorkspaceId, identity, newId, recallActive, rememberActive, streamChat, userTimeZone, type DemoInfo, type Me } from "./api";
import { ChatView, type ChatError, type Notice, type Pending } from "./ChatView";
import { DemoBar } from "./DemoBar";
import { dayLabel } from "./format";
import { LoopsView } from "./LoopsView";
import { MemoryView } from "./MemoryView";
import { SettingsMenu } from "./SettingsMenu";
import { Sidebar } from "./Sidebar";
import type { Conversation, MemorySummary, Message, PersonalEvent, Phase, Status } from "./types";

type View = "chat" | "loops" | "memory";
const VIEWS: Array<{ id: View; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "loops", label: "Open loops" },
  { id: "memory", label: "Memory" },
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

function personalNotices(ev: PersonalEvent): Notice[] {
  const out: Notice[] = [];
  for (const c of ev.created ?? []) {
    const tentative = c.status === "CONSIDERING";
    const verb = tentative ? "Noted as tentative" : c.type === "DECISION" ? "Decision noted" : "Noted";
    out.push({ id: `c-${c.id}`, text: `${verb}: ${c.content}${c.dueDate ? ` — due ${dayLabel(c.dueDate)}` : ""}` });
  }
  for (const t of ev.transitions ?? []) {
    const verb = t.to === "COMPLETED" ? "Marked done" : t.to === "CANCELLED" ? "Cancelled" : t.to === "SUPERSEDED" ? "Superseded" : `Now ${t.to.toLowerCase()}`;
    out.push({ id: `t-${t.id}-${t.to}`, text: `${verb}: ${t.content}` });
  }
  return out;
}

export default function ChatApp() {
  // Workspace id lives in localStorage; read once on the client.
  const [ws] = useState<string | null>(() => (typeof window === "undefined" ? null : getWorkspaceId()));
  const [status, setStatus] = useState<Status | null>(null);
  const [view, setView] = useState<View>("chat");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [memoryByUser, setMemoryByUser] = useState<Record<string, MemorySummary>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [input, setInput] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [railOpen, setRailOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [demo, setDemo] = useState<DemoInfo | null>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const tabRefs = useRef<Record<View, HTMLButtonElement | null>>({ chat: null, loops: null, memory: null });

  const refreshConversations = useCallback(async (workspace: string) => {
    const r = await api.conversations(workspace).catch(() => ({ conversations: [] as Conversation[] }));
    setConversations(r.conversations);
    return r.conversations;
  }, []);

  const loadConversation = useCallback(async (workspace: string, id: string) => {
    setLoadingThread(true);
    const r = await api.conversation(workspace, id).catch(() => null);
    setMessages(r?.messages ?? []);
    setMemoryByUser({});
    setLoadingThread(false);
  }, []);

  // Boot: identity first, then conversations and status.
  useEffect(() => {
    if (!ws) return;
    const id = ws;
    let cancelled = false;
    api.status().then(setStatus).catch(() => setStatus({ configured: false, error: "Server unreachable" }));
    (async () => {
      let m: Me;
      try {
        m = await identity.me();
      } catch {
        m = { mode: "local", signedIn: false, user: null, demo: false, providers: [], demoEnabled: false };
      }
      if (cancelled) return;
      setMe(m);
      // AUTH mode without a session (and no demo): the sign-in screen owns the app.
      if (m.mode === "auth" && !m.signedIn && !m.demo) {
        window.location.replace("/signin?next=%2F");
        return;
      }
      if (m.demo) identity.demoInfo().then((d) => !cancelled && setDemo(d)).catch(() => null);
      const list = await refreshConversations(id);
      if (cancelled) return;
      const remembered = recallActive();
      const pick = list.find((c) => c.id === remembered)?.id ?? list[0]?.id ?? null;
      setActiveId(pick);
      if (pick) loadConversation(id, pick);
      // After a first sign-in, offer to bring the browser's existing data over.
      if (m.signedIn && new URLSearchParams(window.location.search).get("welcome") === "1" && localStorage.getItem("minimi.workspace")) {
        setClaimOpen(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ws, loadConversation, refreshConversations]);

  useEffect(() => rememberActive(activeId), [activeId]);

  const selectConversation = (id: string) => {
    if (!ws || pending) return;
    setView("chat");
    setRailOpen(false);
    setError(null);
    setNotices([]);
    if (id === activeId && messages.length) return;
    setActiveId(id);
    loadConversation(ws, id);
  };

  const newConversation = () => {
    if (pending) return;
    setView("chat");
    setActiveId(null);
    setMessages([]);
    setMemoryByUser({});
    setError(null);
    setNotices([]);
    setRailOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const send = async (raw: string, requestId = newId()) => {
    const text = raw.trim();
    if (!ws || !text || pending) return;
    const tz = userTimeZone();
    const conversationId = activeId ?? newId();
    if (!activeId) setActiveId(conversationId);
    setView("chat");
    setInput("");
    setError(null);
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
          else if (type === "reset") update({ text: "", phase: "searching" });
          else if (type === "done") {
            finished = true;
            const assistant = d.message as Message;
            const user = current.user;
            setMessages((ms) => (d.replayed ? ms : [...ms, user, assistant]));
            setPending(null);
            refreshConversations(ws);
          } else if (type === "memory") setRefreshKey((n) => n + 1);
          else if (type === "personal") {
            const fresh = personalNotices(d as unknown as PersonalEvent);
            if (fresh.length) setNotices((ns) => [...ns.filter((n) => !fresh.some((f) => f.id === n.id)), ...fresh].slice(-4));
            setRefreshKey((n) => n + 1);
          } else if (type === "error") {
            finished = true;
            setPending(null);
            setError({ message: String(d.message), missingVar: d.missingVar as string | undefined, retry: d.code === "config" ? undefined : { text, requestId } });
            if (d.code === "config") setInput(text);
            else loadConversation(ws, conversationId);
            refreshConversations(ws);
          }
        },
        ctrl.signal,
      );
      if (!finished) {
        setPending(null);
        setError({ message: "The connection closed before the answer finished.", retry: { text, requestId } });
        loadConversation(ws, conversationId);
      }
    } catch (e) {
      setPending(null);
      if ((e as Error).name === "AbortError") {
        setTimeout(() => loadConversation(ws, conversationId), 300);
      } else {
        setError({ message: "Could not reach the server.", retry: { text, requestId } });
      }
    } finally {
      abortRef.current = null;
      inputRef.current?.focus();
    }
  };

  const stop = () => abortRef.current?.abort();

  const rename = async (id: string, title: string) => {
    if (!ws || !title.trim()) return;
    await api.rename(ws, id, title.trim()).catch(() => null);
    refreshConversations(ws);
  };

  const removeConversation = async (id: string) => {
    if (!ws || pending) return;
    if (!window.confirm("Delete this conversation and the memory distilled from it?")) return;
    await api.remove(ws, id).catch(() => null);
    const list = await refreshConversations(ws);
    setRefreshKey((n) => n + 1);
    if (id === activeId) {
      const next = list[0]?.id ?? null;
      setActiveId(next);
      if (next) loadConversation(ws, next);
      else setMessages([]);
    }
  };

  const onForgotten = () => {
    setConversations([]);
    setActiveId(null);
    setMessages([]);
    setMemoryByUser({});
    setNotices([]);
    setError(null);
    setInput("");
    setRefreshKey((n) => n + 1);
    setView("chat");
  };

  const signOut = async () => {
    await identity.signOut().catch(() => null);
    window.location.assign("/signin");
  };

  const deleteAccount = async () => {
    await identity.deleteAccount();
    window.location.assign("/signin");
  };

  const resetDemo = async () => {
    if (!ws) return;
    try {
      await identity.resetDemo();
      setConversations([]);
      setActiveId(null);
      setMessages([]);
      setMemoryByUser({});
      setNotices([]);
      setError(null);
      setRefreshKey((n) => n + 1);
      identity.demoInfo().then(setDemo).catch(() => null);
      const list = await refreshConversations(ws);
      const pick = list[0]?.id ?? null;
      setActiveId(pick);
      if (pick) loadConversation(ws, pick);
    } catch (e) {
      setError({ message: (e as Error).message });
    }
  };

  const claim = async () => {
    const localId = typeof window === "undefined" ? null : localStorage.getItem("minimi.workspace");
    setClaimOpen(false);
    if (!localId || !ws) return;
    await identity.claim(localId).catch(() => null);
    await refreshConversations(ws);
    setRefreshKey((n) => n + 1);
  };

  const onTabKey = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % VIEWS.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + VIEWS.length) % VIEWS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = VIEWS.length - 1;
    else return;
    e.preventDefault();
    const v = VIEWS[next]!.id;
    setView(v);
    tabRefs.current[v]?.focus();
  };

  const active = conversations.find((c) => c.id === activeId);

  return (
    <div className="shell">
      <a href="#main" className="skip">
        Skip to content
      </a>
      <Sidebar
        open={railOpen}
        conversations={conversations}
        activeId={activeId}
        busy={!!pending}
        status={status}
        me={me}
        onNew={newConversation}
        onSelect={selectConversation}
        onRename={rename}
        onDelete={removeConversation}
        onClose={() => setRailOpen(false)}
        onSignOut={me?.signedIn ? signOut : undefined}
      />

      <div className="main">
        {me?.demo && demo && (
          <DemoBar
            demo={demo}
            signInHref={me.providers.length ? identity.providerHref(me.providers[0]!, "/") : null}
            onReset={resetDemo}
          />
        )}
        {claimOpen && (
          <div className="claim-bar" role="status">
            <p>You already have conversations in this browser. Bring them into your account?</p>
            <div className="claim-actions">
              <button type="button" className="btn small" onClick={claim}>
                Bring them over
              </button>
              <button type="button" className="btn ghost small" onClick={() => setClaimOpen(false)}>
                Not now
              </button>
            </div>
          </div>
        )}
        <header className="topbar">
          <button type="button" className="icon-btn menu" onClick={() => setRailOpen(true)} aria-label="Open conversations">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
              <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          <div className="tabs" role="tablist" aria-label="Views">
            {VIEWS.map((v, i) => (
              <button
                key={v.id}
                ref={(el) => {
                  tabRefs.current[v.id] = el;
                }}
                type="button"
                role="tab"
                id={`tab-${v.id}`}
                aria-selected={view === v.id}
                aria-controls="main"
                tabIndex={view === v.id ? 0 : -1}
                className={`tab${view === v.id ? " on" : ""}`}
                onClick={() => setView(v.id)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                {v.label}
              </button>
            ))}
          </div>
          <SettingsMenu
            ws={ws}
            me={me}
            onForgotten={onForgotten}
            onSignOut={me?.signedIn ? signOut : undefined}
            onDeleteAccount={me?.signedIn ? deleteAccount : undefined}
            onTryDemo={!me?.signedIn && !me?.demo && me?.demoEnabled ? async () => { try { await identity.startDemo(); window.location.assign("/"); } catch (e) { setError({ message: (e as Error).message }); } } : undefined}
          />
        </header>

        <main id="main" className="stage" role="tabpanel" aria-labelledby={`tab-${view}`} tabIndex={-1}>
          {view === "chat" && (
            <ChatView
              title={active?.title}
              status={status}
              messages={messages}
              loading={loadingThread}
              memoryByUser={memoryByUser}
              pending={pending}
              error={error}
              notices={notices}
              input={input}
              inputRef={inputRef}
              onInput={setInput}
              onSend={send}
              onStop={stop}
              onDismissNotice={(id) => setNotices((ns) => ns.filter((n) => n.id !== id))}
              onOpenLoops={() => setView("loops")}
              demoPrompts={demo?.prompts}
            />
          )}
          {view === "loops" && ws && <LoopsView ws={ws} refreshKey={refreshKey} onOpenConversation={selectConversation} />}
          {view === "memory" && ws && <MemoryView ws={ws} refreshKey={refreshKey} onOpenConversation={selectConversation} />}
        </main>
      </div>
    </div>
  );
}
