"use client";

import type { DemoInfo } from "./api";

function budgetLabel(demo: DemoInfo): string {
  const b = demo.budget;
  if (!b) return "Live answers available";
  if (b.exhausted) return "Live budget spent — memory still works";
  return `${b.turnsRemaining} of ${b.turnsMax} live answers left · ${b.creditsRemaining} of ${b.creditsMax} searches`;
}

/**
 * A persistent, honest label that everything on screen is seeded demo data,
 * with the two escape hatches: start over, or sign in to keep real data.
 */
export function DemoBar({
  demo,
  signInHref,
  onReset,
}: {
  demo: DemoInfo;
  signInHref: string | null;
  onReset: () => void;
}) {
  return (
    <div className="demo-bar" role="status">
      <span className="demo-tag">Demo</span>
      <p>This is a seeded example workspace. Nothing here is your own data, and it is deleted automatically.</p>
      <span className="demo-budget">{budgetLabel(demo)}</span>
      <div className="demo-actions">
        <button type="button" className="btn ghost small" onClick={onReset}>
          Reset demo
        </button>
        {signInHref && (
          <a className="btn small" href={signInHref}>
            Sign in to keep your own data
          </a>
        )}
      </div>
    </div>
  );
}
