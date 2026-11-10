// Live diagnostic: one streamed request through the configured provider's single
// search tool. Prints response *shape* (never the key) so integration details
// can be verified against the real API. Usage: npm run probe
import fs from "node:fs";
import OpenAI from "openai";

for (const f of [".env.local", ".env"]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    // Project file wins over (possibly stale) machine-wide variables, as in the app.
    if (m && m[2].trim()) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
const question = process.argv.slice(2).join(" ") || "What is the current Node.js LTS release? Cite the official source.";

if (provider === "gemini") {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_API_KEY; // the key is passed explicitly; avoid SDK env warnings
  if (!key) {
    console.error("GEMINI_API_KEY is not set (.env.local).");
    process.exit(1);
  }
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: key });
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const t0 = Date.now();
  let first = null;
  let text = "";
  let gm = null;
  try {
    const stream = await ai.models.generateContentStream({
      model,
      contents: question,
      config: { tools: [{ googleSearch: {} }], ...(model.startsWith("gemini-2.5") ? { thinkingConfig: { thinkingBudget: 1024 } } : {}) },
    });
    for await (const chunk of stream) {
      const c = chunk.candidates?.[0];
      if (c?.groundingMetadata?.groundingChunks?.length) gm = c.groundingMetadata;
      const t = (c?.content?.parts ?? []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
      if (t) {
        first ??= Date.now() - t0;
        text += t;
      }
    }
    console.log(`[gemini ${model}] OK in ${Date.now() - t0} ms (first token ${first} ms)`);
    console.log(`  search queries: ${JSON.stringify(gm?.webSearchQueries ?? [])}`);
    console.log(`  grounding chunks: ${gm?.groundingChunks?.length ?? 0} · supports: ${gm?.groundingSupports?.length ?? 0}`);
    console.log(`  first source: ${gm?.groundingChunks?.[0]?.web?.title ?? "-"} ${gm?.groundingChunks?.[0]?.web?.uri?.slice(0, 80) ?? ""}`);
    console.log(`  answer: ${text.slice(0, 300).replace(/\s+/g, " ")}…`);
    if (!gm) console.log("  WARNING: no grounding metadata — Google Search may not be enabled for this key/model.");
  } catch (e) {
    console.log(`[gemini ${model}] FAILED ${e.status ?? ""} ${e.message}`);
    process.exit(1);
  }
} else {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set (.env.local).");
    process.exit(1);
  }
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const client = new OpenAI();
  const t0 = Date.now();
  const r = await client.responses.create({ model, input: question, tools: [{ type: "web_search" }], tool_choice: "auto", include: ["web_search_call.action.sources"], store: false });
  const calls = r.output.filter((o) => o.type === "web_search_call");
  console.log(`[openai ${model}] OK in ${Date.now() - t0} ms · searches: ${calls.length} · sources: ${calls.reduce((n, c) => n + (c.action?.sources?.length ?? 0), 0)}`);
  console.log(`  answer: ${r.output_text.slice(0, 300)}…`);
}
