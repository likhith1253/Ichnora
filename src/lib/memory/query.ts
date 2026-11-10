import { localDateOf, parseDateRefs, type DateRef } from "../time/dates";

/**
 * Deterministic analysis of the user's message. This decides *what memory to
 * fetch* and *whether search is required/forbidden*; it never answers.
 */
export interface QueryAnalysis {
  dateRefs: DateRef[];
  /** "What did I ask you…", "what did we discuss…" */
  asksRecall: boolean;
  /** "still correct", "changed since", "any updates", "shipped since" … */
  asksFreshness: boolean;
  /** "them", "that", "the shortlist" … with nothing else to anchor it */
  hasAnaphora: boolean;
  /** Mentions earlier interaction: "we shortlisted", "you told me", "last time" */
  refersToPast: boolean;
  isGreeting: boolean;
  /** Distinctive content words (entity/topic terms) for lexical retrieval. */
  strongTerms: string[];
  /** Generic topical words (pricing, release…) — weak retrieval signal. */
  weakTerms: string[];
}

const RECALL_RE =
  /\bwhat (?:did|have) (?:i|we) (?:ask|asked|say|said|tell|told|discuss|discussed|talk(?:ed)? about|search(?:ed)?(?: for)?)\b|\bwhat was (?:my|the) (?:question|query)\b|\bdid i (?:ask|mention|tell)\b|\bremind me (?:what|of)\b|\bwhat (?:did you|was your) (?:say|said|answer|tell)\b|\bwhat were we (?:discussing|talking)\b/i;

const FRESHNESS_RE =
  /\bstill (?:correct|true|accurate|valid|right|the case|current|up to date|good)\b|\bchanged?\b|\bchanges\b|\bsince (?:then|that)\b|\bsince\s*\??$|\b(?:any|what's|whats) (?:new|updates?)\b|\bupdated?\b|\bshipped\b|\breleased?\b|\blaunch(?:ed)?\b|\bnew (?:features?|releases?|versions?|pricing)\b|\b(?:today|right now|currently|nowadays)\b|\bout of date\b|\boutdated\b|\bre-?check\b|\bverify\b/i;

const ANAPHORA_RE =
  /\b(?:them|those|these|they|it|its|that one|this one|(?:your|that|this) (?:answer|reply|recommendation|list|shortlist)|the (?:shortlist|list|ones|options|candidates|providers|tools|services|products|vendors|platforms|answer|recommendations?))\b|\bany of (?:them|those)\b|\beach of (?:them|those)\b/i;

const PAST_RE =
  /\b(?:we|you|i) (?:shortlisted|discussed|compared|looked at|talked about|picked|chose|decided|found|recommended|asked|said|mentioned)\b|\b(?:you|u) (?:told|said|recommended|suggested)\b|\blast time\b|\bearlier\b|\bpreviously\b|\bbefore\b|\bour (?:shortlist|list|discussion|conversation|chat)\b|\bi asked you\b/i;

const GREETING_RE = /^\s*(?:hi|hello|hey|yo|hiya|good (?:morning|afternoon|evening)|thanks?(?: you)?|thank u|ok(?:ay)?|cool|great|nice)\b[\s!.,?]*(?:there|minimi)?[\s!.,?]*$/i;

const STOP = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves
  ask asked tell told say said discuss discussed talk talked still correct true accurate valid right today currently current now since then changed change changes changing shipped ship anything something big new latest update updates updated please could would can whether also time last week day days ago yesterday monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec
  shortlist shortlisted list ones options compare compared looked picked chose decided found recommend recommended mention mentioned answer question remind earlier previously one get got know think want like need us lot really much many give show find look check verify recheck`.split(/\s+/),
);

const WEAK = new Set(
  "pricing price prices priced cost costs plan plans tier tiers feature features release releases released launch launched product products tool tools service services provider providers vendor vendors platform platforms team teams seat seats user users month monthly year annual cheap cheaper cheapest best top free paid".split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g) ?? []).map((t) => t.replace(/\.+$/, ""));
}

export function analyzeQuery(text: string, now: Date, timeZone: string): QueryAnalysis {
  const today = localDateOf(now, timeZone);
  const asksRecall = RECALL_RE.test(text);
  const allRefs = parseDateRefs(text, now, timeZone);
  // "…still correct today?" uses "today" as the verification date, not a
  // recall target. Keep a today-reference only for "what did I ask today?".
  const hasPast = allRefs.some((r) => r.end < today);
  const dateRefs = allRefs.filter((r) => r.end < today || (asksRecall && !hasPast));
  const strong: string[] = [];
  const weak: string[] = [];
  for (const t of tokenize(text)) {
    if (t.length < 2 || STOP.has(t) || /^\d{1,2}(st|nd|rd|th)?$/.test(t)) continue;
    if (WEAK.has(t)) {
      if (!weak.includes(t)) weak.push(t);
    } else if (t.length >= 3 || /\d/.test(t)) {
      if (!strong.includes(t)) strong.push(t);
    }
  }
  return {
    dateRefs,
    asksRecall,
    asksFreshness: FRESHNESS_RE.test(text),
    hasAnaphora: ANAPHORA_RE.test(text),
    refersToPast: PAST_RE.test(text) || hasPast,
    isGreeting: GREETING_RE.test(text),
    strongTerms: strong.slice(0, 12),
    weakTerms: weak.slice(0, 8),
  };
}

/** Build a safe FTS5 MATCH expression (quoted terms OR'ed; never raw input). */
export function ftsQuery(terms: string[]): string {
  const safe = terms
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, 16);
  return safe.map((t) => `"${t}"`).join(" OR ");
}
