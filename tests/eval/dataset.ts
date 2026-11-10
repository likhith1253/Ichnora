/**
 * Labelled evaluation fixtures. Synthetic, deterministic, written to probe
 * the failure modes listed in the challenge directive (invented commitments,
 * premature completion, wrong dates, unsupported citations, misrouted search…).
 * Labels are the ground truth; metrics are computed from them, never typed in.
 */

/* ---------------- A. Statement classification (commitments, intentions, decisions…) */
export interface ClassCase {
  text: string;
  /** Expected "TYPE/kind" for each extracted record, or [] for nothing. */
  expect: string[];
  dueDate?: string | null;
  counterparty?: string | null;
}
// "now" for all A cases: Monday 9 Nov 2026, 10:00 Asia/Kolkata
export const CLASSIFICATION: ClassCase[] = [
  { text: "I'll send the project proposal to Rahul by Friday.", expect: ["COMMITMENT/promise"], dueDate: "2026-11-13", counterparty: "Rahul" },
  { text: "I will call the bank tomorrow.", expect: ["COMMITMENT/promise"], dueDate: "2026-11-10" },
  { text: "I promise to review Arjun's PR before 20 Nov.", expect: ["COMMITMENT/promise"], dueDate: "2026-11-20" },
  { text: "We'll ship the beta next week.", expect: ["COMMITMENT/promise"], dueDate: "2026-11-16" },
  { text: "I'm going to email the investors by end of week.", expect: ["COMMITMENT/promise"], dueDate: "2026-11-13" },
  { text: "I need to renew my passport by the end of the month.", expect: ["ACTION_ITEM/obligation"], dueDate: "2026-11-30" },
  { text: "I have to submit the tax form.", expect: ["ACTION_ITEM/obligation"], dueDate: null },
  { text: "I might email Rahul about the budget.", expect: ["ACTION_ITEM/intention"] },
  { text: "Maybe I'll start running again.", expect: ["ACTION_ITEM/intention"] },
  { text: "I'd like to learn Rust someday.", expect: ["ACTION_ITEM/intention"] },
  { text: "I plan to refactor the auth module.", expect: ["ACTION_ITEM/intention"] },
  { text: "If I had more time, I would rewrite the backend.", expect: [] },
  { text: "Suppose we moved to AWS, what would it cost?", expect: [] },
  { text: "Should I email Rahul today?", expect: [] },
  { text: "What's the best CRM for a small team?", expect: [] },
  { text: "Rahul said the deck looks great.", expect: [] },
  { text: "The weather is lovely today.", expect: [] },
  { text: "I sent Rahul the report yesterday.", expect: [] }, // completion evidence, not a new task
  { text: "I'm waiting for Priya to send the signed contract.", expect: ["FOLLOW_UP/waiting"], counterparty: "Priya" },
  { text: "I asked Arjun to review the deck by Thursday.", expect: ["FOLLOW_UP/waiting"], dueDate: "2026-11-12", counterparty: "Arjun" },
  { text: "Meera will send the invoice on Monday.", expect: ["FOLLOW_UP/waiting"], counterparty: "Meera" },
  { text: "We will use MongoDB for the database.", expect: ["DECISION/chosen"] },
  { text: "We have finalized PostgreSQL.", expect: ["DECISION/chosen"] },
  { text: "After comparing them, PostgreSQL seems better.", expect: ["DECISION/considering"] },
  { text: "We have ruled out MySQL.", expect: ["DECISION/rejected"] },
  { text: "I prefer dark mode in every editor.", expect: ["PREFERENCE/like"] },
  { text: "I hate long meetings.", expect: ["PREFERENCE/dislike"] },
  { text: "Our team has 20 sales reps.", expect: ["FACT/stated"] },
  { text: "I work at a fintech startup in Bengaluru.", expect: ["FACT/stated"] },
  { text: "Rahul is my manager.", expect: ["RELATIONSHIP/stated"], counterparty: "Rahul" },
];

/* ---------------- B. Lifecycle sequences (completion must need evidence) */
export interface LifecycleCase {
  name: string;
  steps: Array<{ at: string; text: string }>;
  /** Expected open-loop state after the last step, by content substring. */
  expectOpen: string[];
  expectClosed: string[];
}
export const LIFECYCLE: LifecycleCase[] = [
  {
    name: "explicit completion closes the right task",
    steps: [
      { at: "2026-11-09T04:30:00Z", text: "I'll send Rahul the report by Friday. I'll call Meera tomorrow." },
      { at: "2026-11-11T04:30:00Z", text: "I sent Rahul the report yesterday." },
    ],
    expectOpen: ["Call Meera"],
    expectClosed: ["Send Rahul the report"],
  },
  {
    name: "related chatter does not complete a task",
    steps: [
      { at: "2026-11-09T04:30:00Z", text: "I'll send Rahul the report by Friday." },
      { at: "2026-11-10T04:30:00Z", text: "Rahul's report is long. I sent a meme to Kiran." },
    ],
    expectOpen: ["Send Rahul the report"],
    expectClosed: [],
  },
  {
    name: "ambiguous completion is not applied",
    steps: [
      { at: "2026-11-09T04:30:00Z", text: "I'll send the invoice to Rahul. I'll send the invoice to Meera." },
      { at: "2026-11-10T04:30:00Z", text: "I sent the invoice." },
    ],
    expectOpen: ["invoice to Rahul", "invoice to Meera"],
    expectClosed: [],
  },
  {
    name: "duplicate commitment is reinforced, not duplicated",
    steps: [
      { at: "2026-11-09T04:30:00Z", text: "I'll send the deck to Rahul by Friday." },
      { at: "2026-11-10T04:30:00Z", text: "I'll send the deck to Rahul by Thursday." },
    ],
    expectOpen: ["Send the deck to Rahul"],
    expectClosed: [],
  },
  {
    name: "waiting item closes when the other person delivers",
    steps: [
      { at: "2026-11-09T04:30:00Z", text: "I'm waiting for Priya to send the signed contract." },
      { at: "2026-11-10T04:30:00Z", text: "Priya sent the signed contract this morning." },
    ],
    expectOpen: [],
    expectClosed: ["Priya to send the signed contract"],
  },
  {
    name: "cancellation closes the task as cancelled",
    steps: [
      { at: "2026-11-09T04:30:00Z", text: "I'll call the vendor about the refund." },
      { at: "2026-11-10T04:30:00Z", text: "I no longer need to call the vendor about the refund." },
    ],
    expectOpen: [],
    expectClosed: ["Call the vendor about the refund"],
  },
  {
    name: "a hedge never becomes an open promise",
    steps: [{ at: "2026-11-09T04:30:00Z", text: "I might email Rahul about the budget." }],
    expectOpen: [],
    expectClosed: [],
  },
];

/* ---------------- C. Routing: intent and whether web search is allowed */
export interface RouteCase {
  text: string;
  intent: string;
  /** "none" = must not search; "required" = must search; "auto" = model decides. */
  toolChoice: "none" | "auto" | "required";
}
/** Workspace for C cases: a CRM shortlist on Mon 9 Nov, a Node question on 3 Nov, a promise, decisions. */
export const ROUTING: RouteCase[] = [
  { text: "hi!", intent: "chat", toolChoice: "none" },
  { text: "thanks", intent: "chat", toolChoice: "none" },
  { text: "What did I ask you on 3 November?", intent: "recall", toolChoice: "none" },
  { text: "What did I ask you yesterday?", intent: "recall", toolChoice: "none" },
  { text: "What did I ask you today?", intent: "recall", toolChoice: "none" },
  { text: "What did we discuss last week?", intent: "recall", toolChoice: "none" },
  { text: "What did I ask you on 3 November? Is your answer still correct today?", intent: "recall_and_verify", toolChoice: "required" },
  { text: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", intent: "recall_and_verify", toolChoice: "required" },
  { text: "Has any of them changed pricing since?", intent: "recall_and_verify", toolChoice: "required" },
  { text: "What commitments do I have?", intent: "open_loops", toolChoice: "none" },
  { text: "What's pending?", intent: "open_loops", toolChoice: "none" },
  { text: "What did I promise Rahul?", intent: "open_loops", toolChoice: "none" },
  { text: "What am I waiting for?", intent: "open_loops", toolChoice: "none" },
  { text: "Which deadlines are overdue?", intent: "open_loops", toolChoice: "none" },
  { text: "How has my thinking about the database changed?", intent: "decision_history", toolChoice: "none" },
  { text: "Why did we choose PostgreSQL?", intent: "decision_history", toolChoice: "none" },
  { text: "What is the current price of Notion Plus?", intent: "research", toolChoice: "auto" },
  { text: "What changed in the latest Node.js LTS release?", intent: "research", toolChoice: "auto" },
  { text: "Is it going to rain in Paris today?", intent: "research", toolChoice: "auto" },
  { text: "Compare Neon and Supabase pricing for a side project.", intent: "research", toolChoice: "auto" },
];

/* ---------------- D. Temporal resolution */
export interface DateCase {
  text: string;
  nowIso: string;
  tz: string;
  expect: string | null; // first resolved local date
  kind: "past" | "due";
}
export const DATES: DateCase[] = [
  { text: "on 3 November", nowIso: "2026-11-10T10:00:00Z", tz: "Asia/Kolkata", expect: "2026-11-03", kind: "past" },
  { text: "November 3rd", nowIso: "2026-11-10T10:00:00Z", tz: "Asia/Kolkata", expect: "2026-11-03", kind: "past" },
  { text: "last Tuesday", nowIso: "2026-11-10T10:00:00Z", tz: "Asia/Kolkata", expect: "2026-11-03", kind: "past" },
  { text: "on Monday", nowIso: "2026-11-10T10:00:00Z", tz: "Asia/Kolkata", expect: "2026-11-09", kind: "past" },
  { text: "yesterday", nowIso: "2026-11-10T20:00:00Z", tz: "Asia/Kolkata", expect: "2026-11-10", kind: "past" }, // IST already 11 Nov
  { text: "yesterday", nowIso: "2026-11-10T20:00:00Z", tz: "America/New_York", expect: "2026-11-09", kind: "past" },
  { text: "on 25 December", nowIso: "2026-11-10T10:00:00Z", tz: "Asia/Kolkata", expect: "2025-12-25", kind: "past" },
  { text: "3 days ago", nowIso: "2026-11-10T10:00:00Z", tz: "Asia/Kolkata", expect: "2026-11-07", kind: "past" },
  { text: "by Friday", nowIso: "2026-11-09T04:30:00Z", tz: "Asia/Kolkata", expect: "2026-11-13", kind: "due" },
  { text: "by tomorrow", nowIso: "2026-11-09T19:00:00Z", tz: "Asia/Kolkata", expect: "2026-11-11", kind: "due" }, // IST Tue 00:30
  { text: "next Monday", nowIso: "2026-11-09T04:30:00Z", tz: "Asia/Kolkata", expect: "2026-11-16", kind: "due" },
  { text: "by end of the month", nowIso: "2026-11-09T04:30:00Z", tz: "Asia/Kolkata", expect: "2026-11-30", kind: "due" },
  { text: "before 20 Nov", nowIso: "2026-11-09T04:30:00Z", tz: "Asia/Kolkata", expect: "2026-11-20", kind: "due" },
  { text: "I met him Friday", nowIso: "2026-11-09T04:30:00Z", tz: "Asia/Kolkata", expect: null, kind: "due" }, // no deadline cue
];

/* ---------------- E. Official-source labelling */
export const OFFICIAL: Array<{ url: string; entities: string[]; official: boolean }> = [
  { url: "https://www.hubspot.com/pricing/sales", entities: ["HubSpot"], official: true },
  { url: "https://blog.hubspot.com/sales/hubspot-sales-hub-pricing", entities: ["HubSpot"], official: true },
  { url: "https://www.salesforce.com/sales/pricing/", entities: ["Salesforce"], official: true },
  { url: "https://www.freshworks.com/crm/pricing/", entities: ["Freshsales"], official: true },
  { url: "https://www.zoho.com/crm/zohocrm-pricing.html", entities: ["Zoho CRM"], official: true },
  { url: "https://neon.tech/pricing", entities: ["Neon"], official: true },
  { url: "https://supabase.com/pricing", entities: ["Supabase"], official: true },
  { url: "https://aws.amazon.com/rds/postgresql/pricing/", entities: ["AWS RDS"], official: true },
  { url: "https://nodejs.org/en/about/previous-releases", entities: ["Node.js"], official: true },
  { url: "https://www.pipedrive.com/en/blog/freshsales-vs-monday", entities: ["Freshsales"], official: false },
  { url: "https://www.g2.com/products/hubspot-sales-hub/pricing", entities: ["HubSpot"], official: false },
  { url: "https://www.capterra.com/p/123/Pipedrive/", entities: ["Pipedrive"], official: false },
  { url: "https://medium.com/@x/neon-vs-supabase", entities: ["Neon", "Supabase"], official: false },
  { url: "https://techcrunch.com/2026/10/01/hubspot-price", entities: ["HubSpot"], official: false },
  { url: "https://render.com/pricing", entities: ["Render"], official: true },
  { url: "https://www.reddit.com/r/crm/comments/abc", entities: ["HubSpot"], official: false },
];

/* ---------------- F. Citation validity (model output → rendered links) */
export const CITATIONS: Array<{ text: string; known: string[]; validLinks: string[]; droppedUnknown: number }> = [
  { text: "Node 24【1†https://nodejs.org/en/about/previous-releases】.", known: ["https://nodejs.org/en/about/previous-releases"], validLinks: ["https://nodejs.org/en/about/previous-releases"], droppedUnknown: 0 },
  { text: "Price $19【2†L3-L9】.", known: ["https://a.example/x", "https://neon.tech/pricing"], validLinks: ["https://neon.tech/pricing"], droppedUnknown: 0 },
  { text: "Fake【1†https://evil.example/p】.", known: ["https://nodejs.org/x"], validLinks: [], droppedUnknown: 1 },
  { text: "See (https://supabase.com/pricing).", known: ["https://supabase.com/pricing"], validLinks: ["https://supabase.com/pricing"], droppedUnknown: 0 },
  { text: "See [x](https://made.up/p).", known: ["https://supabase.com/pricing"], validLinks: [], droppedUnknown: 0 },
  { text: "Out of range【9†L1】.", known: ["https://a.example/x"], validLinks: [], droppedUnknown: 1 },
];

/* ---------------- G. Change detection */
export interface ChangeCase {
  name: string;
  then: { raw: string; tier?: string; header?: string; evidence?: "full_page" | "snippet" | "unsourced" };
  now: { raw: string; tier?: string; header?: string; evidence?: "full_page" | "snippet" | "unsourced"; effective?: string } | null;
  expect: "CHANGED" | "NO_MATERIAL_CHANGE" | "UNABLE_TO_VERIFY";
}
export const CHANGES: ChangeCase[] = [
  { name: "price increase, same basis", then: { raw: "$90/seat/month billed annually" }, now: { raw: "$100/seat/month billed annually" }, expect: "CHANGED" },
  { name: "same price", then: { raw: "$25/month" }, now: { raw: "$25 per month" }, expect: "NO_MATERIAL_CHANGE" },
  { name: "monthly vs annual billing", then: { raw: "$90/seat/month billed annually" }, now: { raw: "$100/seat/month billed monthly" }, expect: "UNABLE_TO_VERIFY" },
  { name: "different plans", then: { raw: "$49", tier: "Professional" }, now: { raw: "$14", tier: "Lite" }, expect: "UNABLE_TO_VERIFY" },
  { name: "different currency", then: { raw: "$19/month" }, now: { raw: "€19/month" }, expect: "UNABLE_TO_VERIFY" },
  { name: "no current evidence", then: { raw: "$19/month" }, now: null, expect: "UNABLE_TO_VERIFY" },
  { name: "current value unsourced", then: { raw: "$19/month" }, now: { raw: "$19/month", evidence: "unsourced" }, expect: "UNABLE_TO_VERIFY" },
  { name: "baseline had no exact value", then: { raw: "contact sales" }, now: { raw: "$30/month" }, expect: "UNABLE_TO_VERIFY" },
  { name: "future effective date is still a (scheduled) change", then: { raw: "$19/month" }, now: { raw: "$24/month", effective: "2026-12-01" }, expect: "CHANGED" },
  { name: "rounding noise is not a change", then: { raw: "$19.99/month" }, now: { raw: "$19.99 per month" }, expect: "NO_MATERIAL_CHANGE" },
];
