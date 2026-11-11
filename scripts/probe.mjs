// Live diagnostic for the real keys. Checks, without printing any secret:
//  1. Groq: the model exists for this key and answers.
//  2. Tavily: one basic search (1 credit) returns results with dates.
//  3. End to end: Groq calls web_search, we run Tavily, Groq answers with a citation.
// Usage: npm run probe   (uses .env.local; ~1–3 Tavily credits, ~3 Groq requests)
import fs from "node:fs";
import OpenAI from "openai";

for (const f of [".env", ".env.local"]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    // Project file wins over (possibly stale) machine-wide variables, as in the app.
    if (m && m[2].trim()) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const GROQ = process.env.GROQ_API_KEY;
const TAVILY = process.env.TAVILY_API_KEY;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
let failed = false;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => {
  failed = true;
  console.log(`  ✘ ${m}`);
};

const TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the live web.",
    parameters: { type: "object", properties: { queries: { type: "array", items: { type: "string" }, maxItems: 4 } }, required: ["queries"], additionalProperties: false },
  },
};

async function tavily(query) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY}` },
    body: JSON.stringify({ query, search_depth: "basic", max_results: 5, include_published_date: true }),
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`), { status: res.status });
  return res.json();
}

console.log("\n[1] Groq");
if (!GROQ) bad("GROQ_API_KEY is not set in .env.local");
const groq = GROQ ? new OpenAI({ apiKey: GROQ, baseURL: "https://api.groq.com/openai/v1", maxRetries: 1 }) : null;
if (groq) {
  try {
    const t0 = Date.now();
    const r = await groq.chat.completions.create({ model: MODEL, messages: [{ role: "user", content: "Reply with the single word: ready" }], max_completion_tokens: 200, reasoning_effort: "low" });
    ok(`${MODEL} answered in ${Date.now() - t0} ms: "${(r.choices[0]?.message?.content ?? "").trim().slice(0, 40)}"`);
  } catch (e) {
    bad(`${MODEL} failed: ${e.status ?? ""} ${String(e.message).slice(0, 200)}`);
  }
}

console.log("\n[2] Tavily");
if (!TAVILY) bad("TAVILY_API_KEY is not set in .env.local");
else {
  try {
    const t0 = Date.now();
    const j = await tavily("Node.js LTS release schedule");
    const dated = (j.results ?? []).filter((r) => r.published_date).length;
    ok(`${j.results?.length ?? 0} results in ${Date.now() - t0} ms (${dated} with published_date)`);
    if (j.results?.[0]) ok(`top: ${j.results[0].title} — ${j.results[0].url}`);
  } catch (e) {
    bad(`search failed: ${e.message}${e.status === 432 ? " (free plan quota exhausted)" : ""}`);
  }
}

if (groq && TAVILY && !failed) {
  console.log("\n[3] End to end (tool call → Tavily → cited answer)");
  try {
    const messages = [
      { role: "system", content: "Use web_search for current facts. Cite with Markdown links to returned URLs." },
      { role: "user", content: "What is the current Node.js LTS version? One sentence with a citation." },
    ];
    const t0 = Date.now();
    const r1 = await groq.chat.completions.create({ model: MODEL, messages, tools: [TOOL], tool_choice: "required", reasoning_effort: "low", max_completion_tokens: 1000 });
    const call = r1.choices[0]?.message?.tool_calls?.[0];
    if (!call) throw new Error("model did not call web_search");
    const args = JSON.parse(call.function.arguments || "{}");
    const q = (args.queries ?? [args.query]).filter(Boolean).slice(0, 2);
    ok(`model called ${call.function.name}(${JSON.stringify(q)})`);
    const results = await Promise.all(q.map(tavily));
    const content = results.flatMap((j) => (j.results ?? []).slice(0, 4).map((h) => `- ${h.title}\n  URL: ${h.url}\n  Snippet: ${String(h.content).slice(0, 300)}`)).join("\n");
    // Same technique as the app (agent/groq.ts foldToolExchange): give the final
    // round the evidence as plain context, so gpt-oss does not emit another tool call.
    messages.push({ role: "system", content: `Evidence gathered by web search (cite by Markdown link):
${content}` });
    const r2 = await groq.chat.completions.create({ model: MODEL, messages, reasoning_effort: "low", max_completion_tokens: 800 });
    const answer = r2.choices[0]?.message?.content ?? "";
    ok(`answered in ${Date.now() - t0} ms total`);
    console.log(`  answer: ${answer.replace(/\s+/g, " ").slice(0, 300)}`);
    if (/\]\(https?:\/\/|【[^】]*https?:\/\//.test(answer)) ok("answer cites a source (the app turns gpt-oss 【…】 markers into validated links)");
    else bad("answer has no citation link");
  } catch (e) {
    bad(`end-to-end failed: ${e.status ?? ""} ${String(e.message).slice(0, 220)}`);
  }
}

console.log(failed ? "\nSome checks failed." : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
