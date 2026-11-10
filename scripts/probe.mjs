// Live diagnostic: one streamed request through the configured provider's single
// search tool. Prints response *shape* (never the key) so integration details
// can be verified against the real API. Usage: npm run probe
import fs from "node:fs";
import OpenAI from "openai";

for (const f of [".env.local", ".env"]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const provider = (process.env.LLM_PROVIDER || "groq").toLowerCase();
const question = process.argv.slice(2).join(" ") || "What is the current Node.js LTS release? Cite the official source.";

if (provider === "groq") {
  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY is not set (.env.local).");
    process.exit(1);
  }
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
  for (const toolChoice of ["auto", "required"]) {
    const t0 = Date.now();
    let first = null;
    let text = "";
    const where = new Set();
    let results = 0;
    try {
      const stream = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: question }],
        tools: [{ type: "browser_search" }],
        tool_choice: toolChoice,
        reasoning_effort: "low",
        stream: true,
      });
      for await (const chunk of stream) {
        const c = chunk.choices?.[0];
        const d = c?.delta ?? {};
        for (const [k, v] of [["delta", d.executed_tools], ["x_groq", chunk.x_groq?.executed_tools], ["message", c?.message?.executed_tools]]) {
          if (v) {
            where.add(k);
            for (const t of v) results += t.search_results?.results?.length ?? 0;
          }
        }
        if (d.content) {
          first ??= Date.now() - t0;
          text += d.content;
        }
      }
      console.log(`\n[groq ${model}] tool_choice=${toolChoice}: OK in ${Date.now() - t0} ms (first token ${first} ms)`);
      console.log(`  executed_tools seen in: ${[...where].join(", ") || "none"} · search results: ${results}`);
      console.log(`  citation markers: ${(text.match(/【[^】]*】/g) || []).length} · markdown links: ${(text.match(/\]\(https?:/g) || []).length}`);
      console.log(`  answer: ${text.slice(0, 300).replace(/\s+/g, " ")}…`);
    } catch (e) {
      console.log(`\n[groq ${model}] tool_choice=${toolChoice}: FAILED ${e.status ?? ""} ${e.message}`);
    }
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
