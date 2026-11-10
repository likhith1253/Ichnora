import type { DB } from "../db";
import { createConversation, insertMessage, insertSources, upsertMemoryItems, type Source } from "../db/repo";
import { ingestUserMessage } from "../personal/store";
import { saveChangeReport, saveObservations } from "../research/ledger";
import { compareObservations, extractObservations } from "../research/observations";
import { getWorkspace } from "../auth/accounts";
import { localDateOf } from "../time/dates";

/**
 * Deterministic demo seeding. Everything is written through the app's own
 * storage functions (repo, personal store, research ledger) — never raw SQL —
 * so the demo exercises exactly the same code paths as real use.
 *
 * The seed REFUSES to run unless the workspace is `kind = 'demo'`: the PRD
 * forbids fabricated conversations in a normal workspace.
 */

export interface SeedInput {
  db: DB;
  workspaceId: string;
  now?: Date;
  /** The demo's default timezone (defaults to Asia/Kolkata). */
  timeZone?: string;
}

/** A morning instant (UTC) that lands on the given local calendar day everywhere. */
function at(date: string, minute = 0): Date {
  return new Date(`${date}T06:${String(minute).padStart(2, "0")}:00Z`);
}

function src(url: string, title: string, retrievedAt: string, opts: { official?: boolean; evidence?: "snippet" | "full_page"; sourceNo?: number; query?: string; published?: string } = {}): Source {
  const domain = new URL(url).hostname.replace(/^www\./, "");
  return {
    url,
    title,
    domain,
    retrievedAt,
    origin: "search",
    snippet: null,
    publishedDate: opts.published ?? null,
    query: opts.query ?? null,
    official: opts.official ?? false,
    evidenceLevel: opts.evidence ?? "snippet",
    sourceNo: opts.sourceNo ?? null,
  };
}

const NODE_URL = "https://nodejs.org/en/about/previous-releases";
const HUBSPOT_URL = "https://www.hubspot.com/pricing/sales";
const SALESFORCE_URL = "https://www.salesforce.com/sales/pricing/";
const PIPEDRIVE_URL = "https://www.pipedrive.com/en/pricing";
const ZOHO_URL = "https://www.zoho.com/crm/zohocrm-pricing.html";
const FRESHSALES_URL = "https://www.freshworks.com/crm/pricing/";

const NODE_ANSWER = `**Node 24 is the current LTS line.** It entered long-term support in October 2026 and is the version to use for new production work. [1]

| Line | Status | Latest | Support ends |
|---|---|---|---|
| Node 24 | Active LTS | 24.x | October 2028 |
| Node 22 | Maintenance LTS | 22.x | April 2027 |
| Node 23 | End-of-life | 23.x | June 2026 |

If you are starting a project today, use Node 24 LTS; pin it with an \`.nvmrc\` so your team and CI match.`;

const CRM_ANSWER = `For a 20-person sales team, here is a shortlist of 5 CRMs with official pricing (checked on 9 November 2026):

| CRM | Plan for 20 reps | Price (per user/month, billed annually) | Recent release |
|---|---|---|---|
| [HubSpot](${HUBSPOT_URL}) | Sales Hub Professional | $90 | Breeze AI agents (September 2026) |
| [Salesforce](${SALESFORCE_URL}) | Sales Cloud Enterprise | $165 | Agentforce 3 (June 2026) |
| [Pipedrive](${PIPEDRIVE_URL}) | Professional | $49 | AI email writer |
| [Zoho CRM](${ZOHO_URL}) | Enterprise | $40 | Zia LLM |
| [Freshsales](${FRESHSALES_URL}) | Pro | $39 | Freddy AI copilot |

Every price above is taken from the vendor's own pricing page. HubSpot is the easiest to adopt, Salesforce the most configurable, and Zoho/Freshsales the cheapest at this team size.`;

const RECHECK_ANSWER = `Re-checked the CRM shortlist against each vendor's official pricing page today (10 November 2026):

| CRM | Plan for 20 reps | Price (per user/month, billed annually) | Change since 9 November |
|---|---|---|---|
| [HubSpot](${HUBSPOT_URL}) | Sales Hub Professional | $100 | up from $90 |
| [Salesforce](${SALESFORCE_URL}) | Sales Cloud Enterprise | $165 | no change |
| [Pipedrive](${PIPEDRIVE_URL}) | Professional | $49 | no change |
| [Zoho CRM](${ZOHO_URL}) | Enterprise | $40 | no change |
| [Freshsales](${FRESHSALES_URL}) | Pro | $39 | no change |

**One material change:** HubSpot's Sales Hub Professional list price rose from $90 to $100 per user per month (billed annually). Everything else is unchanged.`;

export function seedDemoWorkspace(input: SeedInput): void {
  const { db, workspaceId } = input;
  const now = input.now ?? new Date();
  const tz = input.timeZone ?? "Asia/Kolkata";
  const ws = getWorkspace(db, workspaceId);
  if (!ws || ws.kind !== "demo") throw new Error("Refusing to seed: not a demo workspace");

  // Anchor the dated history to November of this year, or last year if that
  // November is still ahead of "today", so the example dates are always past.
  const today = localDateOf(now, tz);
  const y = Number(today.slice(0, 4));
  const anchor = today >= `${y}-11-03` ? y : y - 1;
  const nodeDate = `${anchor}-11-03`;
  const crmDate = `${anchor}-11-09`;
  const recheckDate = `${anchor}-11-10`;
  const dbConsiderDate = `${anchor}-11-07`;
  const dbChosenDate = `${anchor}-11-09`;
  const noteDate = `${anchor}-11-06`;
  const intentionDate = `${anchor}-11-08`;

  const say = (conversationId: string, text: string, date: string, minute = 0) => {
    const when = at(date, minute);
    const m = insertMessage(db, { conversationId, workspaceId, role: "user", content: text, timezone: tz, createdAt: when });
    ingestUserMessage(db, { workspaceId, conversationId, messageId: m.id, text, localDate: m.localDate, now: when, timeZone: tz });
    return m;
  };

  db.transaction(() => {
    /* ---- 3 November: a plain research question (date recall, no memory) ---- */
    const convNode = createConversation(db, workspaceId, "Node.js LTS version", at(nodeDate));
    insertMessage(db, { conversationId: convNode.id, workspaceId, role: "user", content: "What is the latest Node.js LTS version?", timezone: tz, createdAt: at(nodeDate) });
    const aNode = insertMessage(db, {
      conversationId: convNode.id,
      workspaceId,
      role: "assistant",
      content: NODE_ANSWER,
      timezone: tz,
      createdAt: at(nodeDate, 0),
      metadata: { intent: "chat", searched: true, searchQueries: ["node.js latest lts version"], model: "demo" },
    });
    insertSources(db, aNode.id, [src(NODE_URL, "Node.js — previous releases", at(nodeDate).toISOString(), { official: true, evidence: "full_page", sourceNo: 1, query: "node.js lts" })]);

    /* ---- 9 November: the CRM shortlist research snapshot ---- */
    const crmSources: Source[] = [
      src(HUBSPOT_URL, "HubSpot Sales Hub pricing", at(crmDate).toISOString(), { official: true, evidence: "full_page", sourceNo: 1, query: "hubspot sales pricing" }),
      src(SALESFORCE_URL, "Salesforce Sales Cloud pricing", at(crmDate).toISOString(), { official: true, evidence: "full_page", sourceNo: 2, query: "salesforce sales cloud pricing" }),
      src(PIPEDRIVE_URL, "Pipedrive pricing", at(crmDate).toISOString(), { official: true, evidence: "snippet", sourceNo: 3, query: "pipedrive pricing" }),
      src(ZOHO_URL, "Zoho CRM pricing", at(crmDate).toISOString(), { official: true, evidence: "snippet", sourceNo: 4, query: "zoho crm pricing" }),
      src(FRESHSALES_URL, "Freshsales pricing", at(crmDate).toISOString(), { official: true, evidence: "snippet", sourceNo: 5, query: "freshsales crm pricing" }),
    ];
    const convCrm = createConversation(db, workspaceId, "CRM shortlist for a 20-person sales team", at(crmDate));
    const uCrm = insertMessage(db, { conversationId: convCrm.id, workspaceId, role: "user", content: "Shortlist the best CRM for a 20-person sales team, with official pricing.", timezone: tz, createdAt: at(crmDate) });
    const aCrm = insertMessage(db, {
      conversationId: convCrm.id,
      workspaceId,
      role: "assistant",
      content: CRM_ANSWER,
      timezone: tz,
      createdAt: at(crmDate, 1),
      metadata: { intent: "research", searched: true, searchQueries: ["crm pricing official", "best crm 20 person sales team"], model: "demo" },
    });
    insertSources(db, aCrm.id, crmSources);
    const crmObs = extractObservations(CRM_ANSWER, crmSources, crmDate);
    const crmSnap = upsertMemoryItems(
      db,
      { workspaceId, conversationId: convCrm.id, sourceMessageIds: [uCrm.id, aCrm.id], baselineDate: crmDate, now: at(crmDate) },
      [
        {
          type: "research_snapshot",
          title: "CRM pricing shortlist (20-person sales team)",
          summary: "Shortlist of five CRMs with official per-seat pricing for a 20-person sales team, checked on 9 November 2026.",
          entities: ["HubSpot", "Salesforce", "Pipedrive", "Zoho CRM", "Freshsales"],
          facts: [
            { entity: "HubSpot", attribute: "price", value: "$90 per user/month (billed annually)", sourceUrl: HUBSPOT_URL },
            { entity: "Salesforce", attribute: "price", value: "$165 per user/month (billed annually)", sourceUrl: SALESFORCE_URL },
            { entity: "Pipedrive", attribute: "price", value: "$49 per user/month (billed annually)", sourceUrl: PIPEDRIVE_URL },
            { entity: "Zoho CRM", attribute: "price", value: "$40 per user/month (billed annually)", sourceUrl: ZOHO_URL },
            { entity: "Freshsales", attribute: "price", value: "$39 per user/month (billed annually)", sourceUrl: FRESHSALES_URL },
          ],
        },
      ],
    );
    if (crmSnap[0]) saveObservations(db, { workspaceId, snapshotId: crmSnap[0].id, messageId: aCrm.id }, crmObs);

    // Commitments and a waiting item mentioned alongside the research.
    say(convCrm.id, "I'll send the project proposal to Rahul by Friday.", crmDate, 2);
    say(convCrm.id, "I'm waiting for Priya to send the contract.", crmDate, 3);

    /* ---- 10 November: the computed re-check against the snapshot ---- */
    const recheckSources = crmSources.map((s) => ({ ...s, retrievedAt: at(recheckDate).toISOString() }));
    const recheckObs = extractObservations(RECHECK_ANSWER, recheckSources, recheckDate);
    const changeRows = compareObservations(crmObs, recheckObs, recheckDate);
    const convRe = createConversation(db, workspaceId, "Re-check: CRM pricing", at(recheckDate));
    const uRe = insertMessage(db, { conversationId: convRe.id, workspaceId, role: "user", content: "Is the CRM shortlist from 9 November still correct today?", timezone: tz, createdAt: at(recheckDate) });
    const changeReport = { baselineSnapshotId: crmSnap[0]?.id ?? null, baselineDate: crmDate, checkedOn: recheckDate, rows: changeRows };
    const aRe = insertMessage(db, {
      conversationId: convRe.id,
      workspaceId,
      role: "assistant",
      content: RECHECK_ANSWER,
      timezone: tz,
      createdAt: at(recheckDate, 1),
      metadata: { intent: "recall_and_verify", searched: true, searchQueries: ["hubspot sales hub pricing", "salesforce sales cloud pricing"], model: "demo", changeReport },
    });
    insertSources(db, aRe.id, recheckSources);
    saveChangeReport(db, aRe.id, changeReport);
    const reSnap = upsertMemoryItems(
      db,
      { workspaceId, conversationId: convRe.id, sourceMessageIds: [uRe.id, aRe.id], baselineDate: recheckDate, now: at(recheckDate) },
      [
        {
          type: "research_snapshot",
          title: "CRM pricing re-check (10 November)",
          summary: 'HubSpot Sales Hub Professional rose from $90 to $100 per user/month; the other shortlisted CRMs are unchanged. (Re-check of "CRM pricing shortlist (20-person sales team)" from 9 November 2026.)',
          entities: ["HubSpot", "Salesforce", "Pipedrive", "Zoho CRM", "Freshsales"],
          facts: [{ entity: "HubSpot", attribute: "price", value: "$100 per user/month (billed annually)", sourceUrl: HUBSPOT_URL }],
        },
      ],
    );
    if (reSnap[0]) saveObservations(db, { workspaceId, snapshotId: reSnap[0].id, messageId: aRe.id }, recheckObs);

    /* ---- 3–9 November: the MongoDB → PostgreSQL decision history ---- */
    const convDb = createConversation(db, workspaceId, "Database migration", at(nodeDate, 5));
    say(convDb.id, "We will use MongoDB for the database.", nodeDate, 5);
    say(convDb.id, "After comparing the databases, PostgreSQL seems better.", dbConsiderDate, 5);
    say(convDb.id, "We will use PostgreSQL for the database.", dbChosenDate, 5);

    /* ---- 6–8 November: a preference and a tentative intention ---- */
    const convNotes = createConversation(db, workspaceId, "Working notes", at(noteDate, 10));
    say(convNotes.id, "I prefer Notion for notes.", noteDate, 10);
    say(convNotes.id, "I might write a blog post about the migration.", intentionDate, 10);
  })();
}
