// Client-side mirrors of server types (kept structural to avoid importing server code).

export interface Source {
  url: string;
  title: string | null;
  domain: string;
  retrievedAt: string;
  origin: "search" | "citation" | "answer_link";
  snippet?: string | null;
  publishedDate?: string | null;
  query?: string | null;
  official?: boolean;
  evidenceLevel?: "snippet" | "full_page";
  sourceNo?: number | null;
}

export interface ChangeSide {
  rawValue?: string | null;
  amount?: number | null;
  currency?: string | null;
  period?: string | null;
  billing?: string | null;
  tier?: string | null;
  observedOn?: string | null;
  sourceUrl?: string | null;
  evidenceLevel?: string | null;
  effectiveDate?: string | null;
  sourcePublished?: string | null;
}

export interface ChangeRow {
  entity: string;
  attribute: string;
  then: ChangeSide | null;
  now: ChangeSide | null;
  status: "CHANGED" | "NO_MATERIAL_CHANGE" | "UNABLE_TO_VERIFY";
  reason: string;
  deltaPct: number | null;
}

export interface ChangeReport {
  baselineSnapshotId: string;
  baselineDate: string;
  checkedOn: string;
  rows: ChangeRow[];
}

export interface MessageMetadata {
  intent?: string;
  searched?: boolean;
  searchUnavailable?: boolean;
  searchQueries?: string[];
  error?: string;
  model?: string;
  claimCoverage?: number | null;
  citedClaims?: number;
  factualClaims?: number;
  pagesRead?: number;
  pagesFailed?: number;
  changeReport?: ChangeReport | null;
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
  metadata: MessageMetadata;
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
  searchConfigured?: boolean;
  missingVar?: string;
  searchTool?: string;
  error?: string;
}

export type Phase = "retrieving" | "thinking" | "searching" | "writing";

// ---- Personal memory -------------------------------------------------------

export type PersonalType = "FACT" | "PREFERENCE" | "DECISION" | "COMMITMENT" | "ACTION_ITEM" | "FOLLOW_UP" | "PROJECT" | "RELATIONSHIP";
export type PersonalStatus = "ACTIVE" | "OPEN" | "WAITING" | "COMPLETED" | "CANCELLED" | "SUPERSEDED" | "CONSIDERING";

export interface PersonalMemory {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  type: PersonalType;
  kind: string;
  subject: string;
  content: string;
  quote: string;
  owner: string | null;
  counterparty: string | null;
  dueDate: string | null;
  eventDate: string;
  status: PersonalStatus;
  confidence: number;
  evidence: "explicit" | "inferred" | "external" | "suggestion";
  rationale: string | null;
  alternatives: string[];
  mentionCount: number;
  userCorrected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryLink {
  fromId: string;
  toId: string;
  relation: string;
  evidenceMessageId: string | null;
  createdAt: string;
}

export interface MemoryEvent {
  memoryId: string;
  at: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  messageId: string | null;
  note: string | null;
}

export interface MemoryView {
  memory: PersonalMemory;
  links: MemoryLink[];
  events: MemoryEvent[];
  sourceMessage: { conversationId: string; createdAtUtc: string; timezone: string } | null;
}

export interface OpenLoops {
  today: string;
  open: PersonalMemory[];
  waiting: PersonalMemory[];
  overdue: PersonalMemory[];
  dueSoon: PersonalMemory[];
  considering: PersonalMemory[];
  recentlyClosed: PersonalMemory[];
}

export interface PersonalResponse {
  today: string;
  items: MemoryView[];
  loops: OpenLoops;
}

export interface PersonalPatch {
  status?: PersonalStatus;
  content?: string;
  dueDate?: string | null;
}

export interface PersonalEvent {
  created: Array<{ id: string; type: string; content: string; dueDate: string | null; status: string }>;
  transitions: Array<{ id: string; content: string; from: string; to: string }>;
}
