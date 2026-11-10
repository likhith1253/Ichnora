"use client";

import type { Conversation, MemoryItem, Message, PersonalMemory, PersonalPatch, PersonalResponse, Status } from "./types";

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
  personal: (ws: string, tz: string) => call<PersonalResponse>(ws, `/api/personal?tz=${encodeURIComponent(tz)}`),
  patchPersonal: (ws: string, id: string, patch: PersonalPatch) =>
    call<{ memory: PersonalMemory }>(ws, `/api/personal/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deletePersonal: (ws: string, id: string) => call(ws, `/api/personal/${id}`, { method: "DELETE" }),
  forgetEverything: (ws: string) => call(ws, "/api/workspace", { method: "DELETE" }),
};

/* ------------------------------------------------------- identity & demo */

export interface MeUser {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt?: string;
}

export interface Me {
  mode: "local" | "auth";
  signedIn: boolean;
  user: MeUser | null;
  demo: boolean;
  providers: string[];
  demoEnabled: boolean;
}

export interface DemoPrompt {
  id: string;
  label: string;
  hint: string;
  text: string;
}

export interface DemoBudget {
  turnsUsed: number;
  turnsMax: number;
  creditsUsed: number;
  creditsMax: number;
  turnsRemaining: number;
  creditsRemaining: number;
  exhausted: boolean;
}

export interface DemoInfo {
  enabled: boolean;
  prompts: DemoPrompt[];
  budget?: DemoBudget;
  expiresAt?: string | null;
}

/** POST/DELETE helper that surfaces the server's error message. */
async function mutate<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const identity = {
  me: (): Promise<Me> => fetch("/api/auth/me", { cache: "no-store" }).then((r) => r.json() as Promise<Me>),
  demoInfo: (): Promise<DemoInfo> => fetch("/api/demo", { cache: "no-store" }).then((r) => r.json() as Promise<DemoInfo>),
  startDemo: () => mutate<{ ok: boolean; workspaceId: string; expiresAt: string }>("/api/demo", { method: "POST" }),
  resetDemo: () => mutate<{ ok: boolean; workspaceId: string; expiresAt: string }>("/api/demo/reset", { method: "POST" }),
  signOut: () => mutate<{ ok: boolean }>("/api/auth/signout", { method: "POST" }),
  deleteAccount: () => mutate<{ ok: boolean }>("/api/auth/account", { method: "DELETE" }),
  claim: (workspaceId: string) =>
    mutate<{ ok: boolean; claimed: boolean }>("/api/auth/claim", { method: "POST", body: JSON.stringify({ workspaceId }) }),
  providerHref: (provider: string, next: string) => `/api/auth/login?provider=${encodeURIComponent(provider)}&next=${encodeURIComponent(next)}`,
};

/** Download the workspace export (header-authenticated, so not a plain link). */
export async function downloadExport(ws: string): Promise<void> {
  const res = await fetch("/api/workspace", { headers: { "x-workspace-id": ws } });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const name = res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "minimi-export.json";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
