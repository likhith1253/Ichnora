// Client-side mirrors of server types (kept structural to avoid importing server code).

export interface Source {
  url: string;
  title: string | null;
  domain: string;
  retrievedAt: string;
  origin: "search" | "citation" | "answer_link";
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "error" | "cancelled";
  createdAtUtc: string;
  timezone: string;
  localDate: string;
  metadata: { intent?: string; searched?: boolean; searchQueries?: string[]; error?: string; model?: string };
  sources: Source[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Fact {
  entity: string;
  attribute: string;
  value: string;
  sourceUrl?: string;
}

export interface MemoryItem {
  id: string;
  conversationId: string;
  type: string;
  title: string;
  summary: string;
  entities: string[];
  facts: Fact[];
  baselineDate: string;
  updatedAt: string;
  origin?: { conversationId: string; createdAtUtc: string; timezone: string; excerpt: string } | null;
}

export interface MemorySummary {
  intent: string;
  toolChoice: string;
  referent: { id: string; title: string; baselineDate: string } | null;
  dateHits: Array<{ phrase: string; start: string; end: string; found: number; assumption?: string }>;
  ambiguous: Array<{ id: string; title: string; baselineDate: string }>;
  relatedCount: number;
  noMemoryFound: boolean;
}

export interface Status {
  provider?: string;
  model?: string;
  configured: boolean;
  missingVar?: string;
  searchTool?: string;
  error?: string;
}

export type Phase = "retrieving" | "thinking" | "searching" | "writing";
