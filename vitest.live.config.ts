import { defineConfig } from "vitest/config";
import path from "node:path";

/** Live evaluations against real Groq + Tavily. Opt-in only: `npm run eval:live`. */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { environment: "node", include: ["tests/live/**/*.live.test.ts"], pool: "forks", testTimeout: 900_000, hookTimeout: 120_000 },
});
