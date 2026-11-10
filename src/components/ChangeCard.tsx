"use client";

import { hostOf, shortDate } from "./format";
import type { ChangeReport, ChangeSide } from "./types";

const STATUS_TEXT = {
  CHANGED: "Changed",
  NO_MATERIAL_CHANGE: "No material change found",
  UNABLE_TO_VERIFY: "Unable to verify",
} as const;

function value(side: ChangeSide | null) {
  if (!side) return <span className="cc-none">not recorded</span>;
  const label =
    side.rawValue ??
    (side.amount != null ? `${side.currency ?? ""}${side.currency ? " " : ""}${side.amount}${side.period ? ` / ${side.period}` : ""}` : null);
  const meta = [side.tier, side.billing].filter(Boolean).join(" · ");
  return (
    <>
      <span className="cc-val">{label ?? "—"}</span>
      {meta && <span className="cc-meta">{meta}</span>}
      {side.sourceUrl && (
        <a className="cc-src" href={side.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
          {hostOf(side.sourceUrl)}
          {side.evidenceLevel === "full_page" ? " · page read" : side.evidenceLevel === "snippet" ? " · snippet" : ""}
        </a>
      )}
    </>
  );
}

/** Then/Now comparison computed by the app (not the model) from recorded evidence. */
export function ChangeCard({ report }: { report: ChangeReport }) {
  if (!report.rows?.length) return null;
  const changed = report.rows.filter((r) => r.status === "CHANGED").length;
  return (
    <section className="change-card" aria-label="Then and now comparison">
      <header>
        <div>
          <h3>Then → Now</h3>
          <p>
            <time>{shortDate(report.baselineDate)}</time> compared with <time>{shortDate(report.checkedOn)}</time>
            {" · "}
            {changed} of {report.rows.length} changed
          </p>
        </div>
        <span className="cc-provenance" title="Computed deterministically from stored snapshots and today's sources; not written by the model.">
          Computed by Minimi from recorded evidence
        </span>
      </header>
      <ul>
        {report.rows.map((r, i) => (
          <li key={`${r.entity}-${r.attribute}-${i}`} className={`cc-row s-${r.status}`}>
            <div className="cc-what">
              <strong>{r.entity}</strong>
              <span>{r.attribute}</span>
            </div>
            <div className="cc-side">
              <span className="cc-label">Then{r.then?.observedOn ? ` · ${shortDate(r.then.observedOn)}` : ""}</span>
              {value(r.then)}
            </div>
            <div className="cc-side">
              <span className="cc-label">Now{r.now?.observedOn ? ` · ${shortDate(r.now.observedOn)}` : ""}</span>
              {value(r.now)}
              {r.now?.effectiveDate && <span className="cc-meta">effective {shortDate(r.now.effectiveDate)}</span>}
            </div>
            <div className="cc-status">
              <span className={`status-pill s-${r.status}`}>{STATUS_TEXT[r.status] ?? r.status}</span>
              {r.deltaPct != null && r.status === "CHANGED" && (
                <span className="cc-delta">
                  {r.deltaPct > 0 ? "+" : ""}
                  {r.deltaPct.toFixed(Math.abs(r.deltaPct) < 10 ? 1 : 0)}%
                </span>
              )}
              {r.reason && <p className="cc-reason">{r.reason}</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
