"use client";

import type { Conversation, MemoryItem, Message, Status } from "./types";

const WS_KEY = "minimi.workspace";
const ACTIVE_KEY = "minimi.activeConversation";

function uuid(): string {
  return crypto.randomUUID();
}

export function getWorkspaceId(): string {
  try {
    let id = localStorage.getItem(WS_KEY);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      id = uuid();
      localStorage.setItem(WS_KEY, id);
    }
    return id;
  } catch {
    return uuid();
  }
}

export function rememberActive(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function recallActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export const newId = uuid;

export function userTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

async function call<T>(ws: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", "x-workspace-id": ws, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);
  return (await res.json()) as T;
}

export const api = {
  status: () => fetch("/api/status").then((r) => r.json() as Promise<Status>),
  conversations: (ws: string) => call<{ conversations: Conversation[] }>(ws, "/api/conversations"),
  createConversation: (ws: string) => call<{ conversation: Conversation }>(ws, "/api/conversations", { method: "POST" }),
  conversation: (ws: string, id: string) =>
    call<{ conversation: Conversation | null; messages: Message[] }>(ws, `/api/conversations/${id}`),
  rename: (ws: string, id: string, title: string) =>
    call(ws, `/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  remove: (ws: string, id: string) => call(ws, `/api/conversations/${id}`, { method: "DELETE" }),
  memory: (ws: string) => call<{ items: MemoryItem[] }>(ws, "/api/memory"),
  forget: (ws: string, id: string) => call(ws, `/api/memory/${id}`, { method: "DELETE" }),
};

/** Minimal SSE reader over fetch (POST bodies are not possible with EventSource). */
export async function streamChat(
  ws: string,
  body: { conversationId: string; text: string; timeZone: string; requestId: string },
  onEvent: (type: string, data: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-workspace-id": ws },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
    onEvent("error", { code: "model", message: err.error });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const type = frame.match(/^event: (.*)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1];
      if (type && data) {
        try {
          onEvent(type, JSON.parse(data));
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}
