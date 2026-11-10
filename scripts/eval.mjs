// Runs the deterministic evaluation suite and writes EVALUATION.md + eval/results.json.
import { spawnSync } from "node:child_process";
const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", "run", "tests/eval", "tests/scenarios.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, EVAL_WRITE: "1" },
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
