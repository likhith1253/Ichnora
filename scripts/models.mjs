// Lists Gemini models available to the configured key and checks which ones
// accept the Google Search tool on this key's tier. Usage: npm run models
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";

for (const f of [".env", ".env.local"]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2].trim()) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const key = process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY is not set (.env.local).");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: key });

const names = [];
const pager = await ai.models.list();
for await (const m of pager) {
  if ((m.supportedActions ?? []).includes("generateContent") && /gemini/.test(m.name) && !/image|tts|audio|live|embedding/.test(m.name)) names.push(m.name.replace(/^models\//, ""));
}
console.log(`generateContent models for this key (${names.length}): ${names.join(", ")}\n`);

const only = process.argv.slice(2);
for (const model of only.length ? only : names) {
  const t0 = Date.now();
  try {
    const r = await ai.models.generateContent({
      model,
      contents: "What is the latest Node.js LTS version today? One sentence.",
      config: { tools: [{ googleSearch: {} }], maxOutputTokens: 512 },
    });
    const gm = r.candidates?.[0]?.groundingMetadata;
    console.log(`OK   ${model.padEnd(32)} ${Date.now() - t0}ms grounded=${Boolean(gm?.groundingChunks?.length)} chunks=${gm?.groundingChunks?.length ?? 0} queries=${JSON.stringify(gm?.webSearchQueries ?? [])}`);
  } catch (e) {
    const msg = String(e.message).match(/"message":\s*"([^"]{0,160})/)?.[1] ?? String(e.message).slice(0, 160);
    console.log(`FAIL ${model.padEnd(32)} ${e.status ?? ""} ${msg}`);
  }
}
