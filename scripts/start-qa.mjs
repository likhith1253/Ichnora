import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const dbPath = path.resolve("data/qa_browser.db");
const port = process.env.PORT || "3010";

const env = {
  ...process.env,
  PORT: port,
  MINIMI_DB_PATH: dbPath,
  PUBLIC_BASE_URL: `http://localhost:${port}`
};

console.log(`[QA SERVER] Starting Next.js on port ${port} with DB ${dbPath}`);

const nextBin = path.resolve("node_modules/next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "start", "-p", port], {
  env,
  stdio: "inherit"
});

child.on("exit", (code) => {
  console.log(`[QA SERVER] Exited with code ${code}`);
  process.exit(code ?? 0);
});

