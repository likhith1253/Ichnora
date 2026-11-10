import type { DB } from "../db";
import type { Extraction } from "../search/types";
import type { ClaimEvidence } from "./claims";
import { observationsFromFacts, type ChangeRow, type Observation } from "./observations";

/** Persistence for the temporal evidence ledger. */

export function saveExtractions(db: DB, messageId: string, pages: Extraction[]): void {
  const stmt = db.prepare("INSERT INTO source_extractions(message_id, url, retrieved_at, ok, chars, excerpt, error) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const p of pages) stmt.run(messageId, p.url, p.retrievedAt, p.ok ? 1 : 0, p.content.length, p.ok ? p.content.slice(0, 1400) : null, p.error ?? null);
  })();
}

export function saveClaims(db: DB, messageId: string, claims: ClaimEvidence[]): void {
  const stmt = db.prepare("INSERT INTO claim_evidence(message_id, claim, url, official, evidence_level) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const c of claims.slice(0, 80)) stmt.run(messageId, c.claim, c.url, c.official ? 1 : 0, c.evidenceLevel);
  })();
}

export function claimsFor(db: DB, messageId: string): ClaimEvidence[] {
  return (db.prepare("SELECT claim, url, official, evidence_level FROM claim_evidence WHERE message_id = ? ORDER BY id").all(messageId) as Array<{
    claim: string;
    url: string;
    official: number;
    evidence_level: "snippet" | "full_page";
  }>).map((r) => ({ claim: r.claim, url: r.url, official: r.official === 1, evidenceLevel: r.evidence_level }));
}

export function saveObservations(db: DB, ctx: { workspaceId: string; snapshotId: string; messageId: string }, obs: Observation[]): void {
  const stmt = db.prepare(
    `INSERT INTO observations(workspace_id, snapshot_id, message_id, entity, entity_norm, attribute, raw_value, amount, currency, period, billing, unit, tier,
       observed_on, effective_date, source_url, source_published, evidence_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const o of obs.slice(0, 80)) {
      stmt.run(ctx.workspaceId, ctx.snapshotId, ctx.messageId, o.entity, o.entityNorm, o.attribute, o.rawValue, o.amount, o.currency, o.period, o.billing, o.unit, o.tier, o.observedOn, o.effectiveDate, o.sourceUrl, o.sourcePublished, o.evidenceLevel);
    }
  })();
}

interface ObsRow {
  entity: string;
  entity_norm: string;
  attribute: string;
  raw_value: string;
  amount: number | null;
  currency: string | null;
  period: Observation["period"];
  billing: Observation["billing"];
  unit: Observation["unit"];
  tier: string | null;
  observed_on: string;
  effective_date: string | null;
  source_url: string | null;
  source_published: string | null;
  evidence_level: Observation["evidenceLevel"];
}

/** Baseline observations for a research snapshot (falls back to legacy facts JSON). */
export function snapshotObservations(db: DB, snapshot: { id: string; baselineDate: string; facts: Array<{ entity: string; attribute: string; value: string; sourceUrl?: string }> }): Observation[] {
  const rows = db.prepare("SELECT * FROM observations WHERE snapshot_id = ? ORDER BY id").all(snapshot.id) as ObsRow[];
  if (rows.length === 0) return observationsFromFacts(snapshot.facts, snapshot.baselineDate);
  return rows.map((r) => ({
    entity: r.entity,
    entityNorm: r.entity_norm,
    attribute: r.attribute,
    rawValue: r.raw_value,
    amount: r.amount,
    currency: r.currency,
    period: r.period,
    billing: r.billing,
    unit: r.unit,
    tier: r.tier,
    observedOn: r.observed_on,
    effectiveDate: r.effective_date,
    sourceUrl: r.source_url,
    sourcePublished: r.source_published,
    evidenceLevel: r.evidence_level,
  }));
}

export interface ChangeReport {
  baselineSnapshotId: string | null;
  baselineDate: string | null;
  checkedOn: string;
  rows: ChangeRow[];
}

export function saveChangeReport(db: DB, messageId: string, report: ChangeReport): void {
  db.prepare("INSERT OR REPLACE INTO change_reports(message_id, baseline_snapshot_id, baseline_date, checked_on, rows) VALUES (?, ?, ?, ?, ?)").run(
    messageId,
    report.baselineSnapshotId,
    report.baselineDate,
    report.checkedOn,
    JSON.stringify(report.rows),
  );
}
