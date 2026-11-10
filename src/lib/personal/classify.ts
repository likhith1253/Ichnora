import { parseDateRefs, localDateOf } from "../time/dates";
import { parseDueDate } from "../time/due";

/**
 * Deterministic statement classifier for USER messages (never assistant text:
 * a model suggestion must not become the user's commitment or fact).
 *
 * Design: precision over recall. Each sentence is classified into one intent
 * class; ambiguous or hedged language is either stored as a low-confidence
 * *intention* or skipped. Rules are explicit so every decision is testable and
 * costs no LLM tokens on the free tier.
 */

export const EXTRACTION_VERSION = 1;

export type MemoryType = "FACT" | "PREFERENCE" | "DECISION" | "COMMITMENT" | "ACTION_ITEM" | "FOLLOW_UP" | "PROJECT" | "RELATIONSHIP";
export type MemoryStatus = "ACTIVE" | "OPEN" | "WAITING" | "COMPLETED" | "CANCELLED" | "SUPERSEDED" | "CONSIDERING";

export interface Candidate {
  type: MemoryType;
  /** promise | obligation | intention | waiting | chosen | considering | rejected | stated | preference */
  kind: string;
  subject: string;
  content: string;
  quote: string;
  owner: string | null;
  counterparty: string | null;
  dueDate: string | null;
  eventDate: string;
  status: MemoryStatus;
  confidence: number;
  evidence: "explicit" | "inferred";
  rationale: string | null;
  alternatives: string[];
  people: string[];
  /** For commitments: verb group + object tokens used to match later completion evidence. */
  verbGroup: string | null;
  objectTokens: string[];
}

/** Evidence that acts on existing memories rather than creating one. */
export interface Signal {
  kind: "completion" | "cancellation" | "counterpart_done";
  quote: string;
  eventDate: string;
  verbGroup: string | null;
  objectTokens: string[];
  people: string[];
}

export interface Classified {
  candidates: Candidate[];
  signals: Signal[];
}

/* ---------------------------------------------------------------- lexicon */

/** Verb groups so "sent" can complete "email" and "submit". */
const VERB_GROUPS: Record<string, string[]> = {
  send: ["send", "sent", "email", "emailed", "mail", "mailed", "forward", "forwarded", "share", "shared", "submit", "submitted", "deliver", "delivered", "upload", "uploaded", "file", "filed"],
  call: ["call", "called", "ring", "rang", "phone", "phoned"],
  message: ["message", "messaged", "text", "texted", "ping", "pinged", "reply", "replied", "respond", "responded", "write back", "wrote back"],
  meet: ["meet", "met", "schedule", "scheduled", "book", "booked"],
  review: ["review", "reviewed", "check", "checked", "read"],
  finish: ["finish", "finished", "complete", "completed", "wrap up", "wrapped up", "do", "did", "done"],
  write: ["write", "wrote", "draft", "drafted", "prepare", "prepared", "create", "created", "build", "built"],
  fix: ["fix", "fixed", "resolve", "resolved", "debug", "debugged", "deploy", "deployed", "ship", "shipped", "release", "released"],
  pay: ["pay", "paid", "renew", "renewed", "buy", "bought", "order", "ordered"],
  sign: ["sign", "signed", "approve", "approved", "confirm", "confirmed"],
  return: ["return", "returned", "give back", "gave back"],
  update: ["update", "updated", "tell", "told", "inform", "informed", "let know"],
};
const VERB_TO_GROUP = new Map<string, string>();
for (const [g, vs] of Object.entries(VERB_GROUPS)) for (const v of vs) VERB_TO_GROUP.set(v, g);

const PAST_VERBS = Object.values(VERB_GROUPS)
  .flat()
  .filter((v) => /ed$|sent|did|done|met|wrote|built|paid|bought|told|rang|gave|read$/.test(v));

const HEDGES = /\b(might|maybe|perhaps|possibly|probably|not sure|thinking (?:about|of)|considering|hopefully|hope to|would like to|i'd like to|i may|we may|i could|we could|if i get time|if time permits|at some point|someday)\b/i;
const HYPOTHETICAL = /^\s*(?:if|suppose|supposing|imagine|what if|assuming|in case|unless)\b|\bwould have\b|\bif i (?:were|had)\b/i;

/** Category nouns used as decision/preference subjects. */
const CATEGORY_NOUNS = [
  "database", "db", "crm", "hosting", "host", "framework", "language", "cloud", "provider", "vendor", "stack",
  "frontend", "backend", "orm", "cache", "queue", "editor", "laptop", "phone", "plan", "tool", "library", "platform", "payment", "auth",
];
/** Well-known names → category, so "PostgreSQL seems better" files under "database". */
const KNOWN_CATEGORY: Record<string, string> = {
  postgres: "database", postgresql: "database", mysql: "database", mongodb: "database", mongo: "database", sqlite: "database",
  dynamodb: "database", redis: "cache", supabase: "database", neon: "database", planetscale: "database", cockroachdb: "database",
  hubspot: "crm", salesforce: "crm", pipedrive: "crm", zoho: "crm", freshsales: "crm",
  react: "frontend", vue: "frontend", svelte: "frontend", angular: "frontend", nextjs: "frontend", "next.js": "frontend",
  aws: "cloud", gcp: "cloud", azure: "cloud", vercel: "hosting", render: "hosting", netlify: "hosting", heroku: "hosting", railway: "hosting",
  prisma: "orm", drizzle: "orm", stripe: "payment", razorpay: "payment",
};

const NOT_NAMES = new Set(
  "I I'll I'm I've We We'll Our My The This That These Those It He She They Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December Today Tomorrow Yesterday Next Last Also Then After Before OK Okay Yes No Please Thanks Hi Hello Hey Maybe Probably".split(" "),
);

const STOP = new Set("a an the to for of and or with on in at by my our your his her their this that it is be will shall would should can could i we you he she they me us them just also please some any from about into up down out over".split(" "));

/* ---------------------------------------------------------------- helpers */

export function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 600);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function contentTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t) && !VERB_TO_GROUP.has(t));
}

/** Capitalised words that look like people/organisation names (not sentence-initial pronouns, days, months). */
export function findNames(sentence: string): string[] {
  const out: string[] = [];
  const re = /\b([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})?)\b/g;
  for (const m of sentence.matchAll(re)) {
    const name = m[1]!;
    const first = name.split(" ")[0]!;
    if (NOT_NAMES.has(first)) continue;
    // Sentence-initial capital only counts if followed by a typical person context.
    if (m.index === 0 && !/^\w+\s+(?:said|will|is|has|sent|replied|promised|asked)\b/.test(sentence)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function verbGroupOf(phrase: string): string | null {
  const words = phrase.toLowerCase().split(/\s+/);
  for (let i = 0; i < Math.min(words.length, 3); i++) {
    const two = `${words[i]} ${words[i + 1] ?? ""}`.trim();
    if (VERB_TO_GROUP.has(two)) return VERB_TO_GROUP.get(two)!;
    if (VERB_TO_GROUP.has(words[i]!)) return VERB_TO_GROUP.get(words[i]!)!;
  }
  return null;
}

/** Strip trailing deadline/time phrases and reason clauses from an action phrase. */
function cleanAction(action: string): string {
  return action
    .replace(/\s+(?:by|before|until|till|due|on|no later than|this|next)\s+.*$/i, "")
    .replace(/\s+(?:tomorrow|today|tonight|later|soon|asap)\b.*$/i, "")
    .replace(/\s+(?:because|since|as|so that)\s+.*$/i, "")
    .replace(/[.,!?;:]+$/, "")
    .trim();
}

function subjectFor(sentence: string, choice: string | null): string {
  const lower = sentence.toLowerCase();
  for (const n of CATEGORY_NOUNS) if (new RegExp(`\\b${n}s?\\b`).test(lower)) return n === "db" ? "database" : n === "host" ? "hosting" : n;
  if (choice) {
    const k = choice.toLowerCase().replace(/[^a-z0-9.]+/g, "");
    if (KNOWN_CATEGORY[k]) return KNOWN_CATEGORY[k]!;
    return choice.toLowerCase();
  }
  return "general";
}

function rationaleOf(sentence: string): string | null {
  const m = sentence.match(/\b(?:because|since|as it|due to|given that)\s+(.{4,240})$/i);
  return m ? m[1]!.replace(/[.!]+$/, "").trim() : null;
}

function choiceAfter(sentence: string, verbEnd: number): string | null {
  const rest = sentence.slice(verbEnd).replace(/^\s*(?:to use|on|with|for)?\s*/i, "");
  const m = rest.match(/^([A-Za-z0-9][\w.+#-]*(?:\s+[A-Z0-9][\w.+#-]*){0,2})/);
  if (!m) return null;
  const c = m[1]!.replace(/\s+(?:because|since|over|instead|for|as)$/i, "").replace(/[.,;:!?]+$/, "").trim();
  return /^(?:it|this|that|them|one|the|a|an)$/i.test(c) ? null : c;
}

/* ---------------------------------------------------------------- main */

export function classifyMessage(text: string, now: Date, timeZone: string): Classified {
  const today = localDateOf(now, timeZone);
  const candidates: Candidate[] = [];
  const signals: Signal[] = [];

  for (const quote of splitSentences(text)) {
    const s = quote;
    if (/\?\s*$/.test(s)) continue; // questions are requests, not statements
    if (HYPOTHETICAL.test(s)) continue; // hypotheticals never become memory
    const people = findNames(s);
    const pastRef = parseDateRefs(s, now, timeZone).find((r) => r.end <= today);
    const eventDate = pastRef?.start ?? today;
    const base = { quote: s, people, eventDate, rationale: rationaleOf(s), alternatives: [] as string[], evidence: "explicit" as const };

    /* ---- completion evidence: "I sent Rahul the report yesterday" */
    const comp = s.match(new RegExp(`\\b(?:I|we)\\s+(?:have\\s+|'ve\\s+|just\\s+|already\\s+|finally\\s+)*(${PAST_VERBS.map((v) => v.replace(" ", "\\s+")).join("|")})\\b(.*)$`, "i"));
    if (comp && !HEDGES.test(s) && !/\b(?:will|'ll|going to|need to|have to)\b/i.test(s.slice(0, comp.index ?? 0) + comp[0].slice(0, 12))) {
      signals.push({ kind: "completion", quote: s, eventDate, verbGroup: VERB_TO_GROUP.get(comp[1]!.toLowerCase().replace(/\s+/g, " ")) ?? null, objectTokens: contentTokens(comp[2] ?? ""), people });
      continue;
    }
    if (/\b(?:is|are|was|were)\s+(?:done|finished|complete|completed|sent|submitted)\b/i.test(s) && !HEDGES.test(s) && !/\bnot\b/i.test(s)) {
      signals.push({ kind: "completion", quote: s, eventDate, verbGroup: null, objectTokens: contentTokens(s), people });
      continue;
    }

    /* ---- cancellation: "I no longer need to call Priya" / "cancel the demo" */
    const canc = s.match(/\b(?:I|we)\s+(?:no longer need to|don't need to|do not need to|won't|will not|am not going to|'m not going to|cancelled|canceled|decided not to)\s+(.+)$/i);
    if (canc) {
      signals.push({ kind: "cancellation", quote: s, eventDate, verbGroup: verbGroupOf(canc[1]!), objectTokens: contentTokens(canc[1]!), people });
      continue;
    }

    /* ---- counterpart delivered: "Rahul sent me the numbers" / "Priya replied" */
    const cp = s.match(/\b([A-Z][a-z]{1,20})\s+(?:has\s+|finally\s+|already\s+)?(sent|replied|responded|got back|shared|confirmed|reviewed|approved|delivered|called)\b(.*)$/);
    if (cp && !NOT_NAMES.has(cp[1]!) && !HEDGES.test(s)) {
      signals.push({ kind: "counterpart_done", quote: s, eventDate, verbGroup: VERB_TO_GROUP.get(cp[2]!.toLowerCase()) ?? "message", objectTokens: contentTokens(cp[3] ?? ""), people: [cp[1]!] });
      continue;
    }

    /* ---- waiting on someone else */
    const wait =
      s.match(/\b(?:I'?m|I am|we'?re|we are|still)\s+waiting\s+(?:for|on)\s+([A-Z][a-z]{1,20})\s+to\s+(.+)$/) ??
      s.match(/\b(?:I|we)\s+asked\s+([A-Z][a-z]{1,20})\s+to\s+(.+)$/) ??
      s.match(/\b([A-Z][a-z]{1,20})\s+(?:will|'ll|promised to|said (?:he|she|they)(?:'d| would)|is going to|has to)\s+(.+)$/);
    if (wait && !NOT_NAMES.has(wait[1]!) && !/^(?:I|We)$/.test(wait[1]!)) {
      const action = cleanAction(wait[2]!);
      const due = parseDueDate(s, now, timeZone);
      candidates.push({
        ...base,
        type: "FOLLOW_UP",
        kind: "waiting",
        subject: `waiting:${wait[1]!.toLowerCase()}:${contentTokens(action).slice(0, 3).join("-") || "item"}`,
        content: `${wait[1]} to ${action}`,
        owner: wait[1]!,
        counterparty: wait[1]!,
        dueDate: due?.date ?? null,
        status: "WAITING",
        confidence: HEDGES.test(s) ? 0.5 : 0.85,
        verbGroup: verbGroupOf(action),
        objectTokens: contentTokens(action),
      });
      continue;
    }
    const waitGeneric = s.match(/\b(?:I'?m|I am|we'?re|we are|still)\s+waiting\s+(?:for|on)\s+(.{3,120})$/i);
    if (waitGeneric) {
      const what = cleanAction(waitGeneric[1]!);
      const from = what.match(/\bfrom\s+([A-Z][a-z]{1,20})\b/)?.[1] ?? people[0] ?? null;
      candidates.push({
        ...base,
        type: "FOLLOW_UP",
        kind: "waiting",
        subject: `waiting:${(from ?? "someone").toLowerCase()}:${contentTokens(what).slice(0, 3).join("-") || "item"}`,
        content: `Waiting for ${what}`,
        owner: from,
        counterparty: from,
        dueDate: parseDueDate(s, now, timeZone)?.date ?? null,
        status: "WAITING",
        confidence: 0.8,
        verbGroup: null,
        objectTokens: contentTokens(what),
      });
      continue;
    }

    /* ---- decisions (before commitments: "we will use X" is a decision) */
    const decided = s.match(/\b(?:we|I)\s+(?:have\s+|'ve\s+)?(?:finally\s+)?(decided (?:to use|on|to go with)?|finali[sz]ed|chose|have chosen|picked|settled on|selected|are going with|'re going with|will go with|'ll go with|went with|will use|'ll use|are using|'re using|switched to|are switching to|'re switching to)\b/i);
    if (decided && !HEDGES.test(s)) {
      const choice = choiceAfter(s, (decided.index ?? 0) + decided[0].length);
      if (choice) {
        const subject = subjectFor(s, choice);
        candidates.push({
          ...base,
          type: "DECISION",
          kind: "chosen",
          subject,
          content: `Chose ${choice} for ${subject}`,
          owner: /\bwe\b/i.test(decided[0]) ? "team" : "user",
          counterparty: null,
          dueDate: null,
          status: "ACTIVE",
          confidence: /finali[sz]ed|decided|settled/i.test(decided[0]) ? 0.95 : 0.85,
          alternatives: (s.match(/\b(?:over|instead of|rather than)\s+([A-Z][\w.+#-]*)/)?.[1] ? [s.match(/\b(?:over|instead of|rather than)\s+([A-Z][\w.+#-]*)/)![1]!] : []),
          verbGroup: null,
          objectTokens: [choice.toLowerCase()],
        });
        continue;
      }
    }
    const rejected = s.match(/\b(?:we|I)\s+(?:have\s+)?(ruled out|rejected|decided against|are dropping|'re dropping|dropped|are not going with|'re not going with|won't use|will not use)\s+([A-Z][\w.+#-]*)/i);
    if (rejected) {
      const choice = rejected[2]!;
      const subject = subjectFor(s, choice);
      candidates.push({
        ...base,
        type: "DECISION",
        kind: "rejected",
        subject,
        content: `Rejected ${choice} for ${subject}`,
        owner: "user",
        counterparty: null,
        dueDate: null,
        status: "ACTIVE",
        confidence: 0.9,
        verbGroup: null,
        objectTokens: [choice.toLowerCase()],
      });
      continue;
    }
    const leaning =
      s.match(/\b([A-Z][\w.+#-]*)\s+(?:seems|looks|is)\s+(?:better|the better option|like the better|preferable|stronger)/) ??
      s.match(/\b(?:leaning towards|leaning toward|inclined towards|considering|evaluating|thinking of using|looking at)\s+([A-Z][\w.+#-]*)/i);
    if (leaning) {
      const choice = leaning[1]!;
      const subject = subjectFor(s, choice);
      candidates.push({
        ...base,
        type: "DECISION",
        kind: "considering",
        subject,
        content: `Considering ${choice} for ${subject}`,
        owner: "user",
        counterparty: null,
        dueDate: null,
        status: "CONSIDERING",
        confidence: 0.6,
        evidence: "explicit",
        verbGroup: null,
        objectTokens: [choice.toLowerCase()],
      });
      continue;
    }

    /* ---- commitments, obligations, intentions */
    const commit = s.match(/\b(I|we)\s*(?:'ll|will|shall|promise(?:d)? to|am going to|'m going to|are going to|'re going to|commit to|plan to|intend to|need to|have to|must|should|might|may|could|'d like to|would like to|hope to|want to)\s+(?:definitely\s+|also\s+|probably\s+|try to\s+)?([a-z][^,;]{2,200})/i);
    if (commit) {
      const who = commit[1]!.toLowerCase() === "we" ? "team" : "user";
      const modal = s.slice(commit.index ?? 0, (commit.index ?? 0) + commit[0].length).toLowerCase();
      const action = cleanAction(commit[2]!);
      const vg = verbGroupOf(action);
      if (/^(?:think|consider|see|look into whether|wonder|be|feel|keep)\b/i.test(action)) continue; // not actionable
      const hedged = HEDGES.test(s) || /\b(?:might|may|could|'d like to|would like to|hope to|want to|should)\b/.test(modal);
      const obligation = /\b(?:need to|have to|must)\b/.test(modal);
      const planned = /\b(?:plan to|intend to)\b/.test(modal);
      const due = parseDueDate(s, now, timeZone);
      const counterparty = people.find((p) => new RegExp(`\\b${p}\\b`).test(action)) ?? null;
      candidates.push({
        ...base,
        type: hedged || planned ? "ACTION_ITEM" : obligation ? "ACTION_ITEM" : "COMMITMENT",
        kind: hedged ? "intention" : planned ? "intention" : obligation ? "obligation" : "promise",
        subject: `task:${vg ?? "do"}:${contentTokens(action).slice(0, 4).join("-") || "item"}`,
        content: cap(action),
        owner: who,
        counterparty,
        dueDate: due?.date ?? null,
        status: hedged ? "CONSIDERING" : "OPEN",
        confidence: hedged ? 0.4 : planned ? 0.65 : obligation ? 0.8 : 0.9,
        evidence: hedged ? "inferred" : "explicit",
        verbGroup: vg,
        objectTokens: contentTokens(action),
      });
      continue;
    }

    /* ---- preferences */
    const pref = s.match(/\bI\s+(?:really\s+|strongly\s+)?(prefer|like|love|hate|dislike|don't like|do not like|can't stand|always use|never use|usually use)\s+(.{2,160})$/i);
    if (pref && !/\bI'?d like to\b|would like to/i.test(s)) {
      const neg = /hate|dislike|don't|do not|can't|never/i.test(pref[1]!);
      const obj = pref[2]!.replace(/[.!]+$/, "").replace(/\s+(?:because|since)\s+.*$/i, "").trim();
      // Key on the purpose ("for notes") so "Notion for notes" → "Obsidian for notes" supersedes.
      const purpose = obj.match(/\bfor\s+(.{2,60})$/i)?.[1];
      const head = contentTokens(purpose ?? obj).filter((t) => t !== "now").slice(0, 3).join("-") || "general";
      candidates.push({
        ...base,
        type: "PREFERENCE",
        kind: neg ? "dislike" : "like",
        subject: `pref:${purpose ? head : subjectFor(s, null) !== "general" ? subjectFor(s, null) : head}`,
        content: `${neg ? "Dislikes" : "Prefers"} ${obj}`,
        owner: "user",
        counterparty: null,
        dueDate: null,
        status: "ACTIVE",
        confidence: 0.85,
        verbGroup: null,
        objectTokens: contentTokens(obj),
      });
      continue;
    }

    /* ---- personal / project facts */
    const fact =
      s.match(/\b(?:I am|I'm)\s+(?:a|an|the)\s+(.{3,120})$/i) ??
      s.match(/\bI\s+work\s+(?:at|for|as|on)\s+(.{2,120})$/i) ??
      s.match(/\b(?:my|our)\s+(name|role|team|company|startup|budget|deadline|manager|stack|product|project)\s+(?:is|has|are)\s+(.{2,120})$/i) ??
      s.match(/\b(?:we are|we're)\s+(?:a|an)\s+(.{3,120})$/i);
    if (fact && !HEDGES.test(s)) {
      const key = fact.length > 2 && fact[2] ? fact[1]!.toLowerCase() : /work/i.test(fact[0]) ? "work" : /we/i.test(fact[0]) ? "team" : "identity";
      const isProject = /\b(project|product|startup)\b/i.test(fact[0]);
      candidates.push({
        ...base,
        type: isProject ? "PROJECT" : "FACT",
        kind: "stated",
        subject: `fact:${key}`,
        content: s.replace(/[.!]+$/, ""),
        owner: "user",
        counterparty: null,
        dueDate: null,
        status: "ACTIVE",
        confidence: 0.9,
        verbGroup: null,
        objectTokens: contentTokens(s),
      });
      continue;
    }

    /* ---- relationships: "Rahul is my manager" */
    const rel = s.match(/\b([A-Z][a-z]{1,20})\s+is\s+(?:my|our)\s+(manager|boss|cofounder|co-founder|colleague|client|investor|mentor|teammate|friend|lead|designer|engineer|advisor)\b/);
    if (rel && !NOT_NAMES.has(rel[1]!)) {
      candidates.push({
        ...base,
        type: "RELATIONSHIP",
        kind: "stated",
        subject: `rel:${rel[1]!.toLowerCase()}`,
        content: `${rel[1]} is the user's ${rel[2]}`,
        owner: "user",
        counterparty: rel[1]!,
        dueDate: null,
        status: "ACTIVE",
        confidence: 0.9,
        verbGroup: null,
        objectTokens: [rel[2]!.toLowerCase()],
      });
    }
  }
  return { candidates, signals };
}
