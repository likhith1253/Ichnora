import { GoogleGenAI, type Content, type GenerateContentConfig, type GroundingChunk, type GroundingSupport } from "@google/genai";
import type { AppConfig } from "../env";
import type { ModelRequest } from "./prompt";
import { assertSingleSearchTool, type LlmProvider, type ProviderEvent } from "./provider";
import type { RawSource } from "./sources";

/**
 * Gemini adapter. The model's one tool is Google Search grounding
 * (`{ googleSearch: {} }`). On the free tier this is available for the
 * Gemini 2.5 Flash family.
 *
 * Differences from OpenAI-style tools, handled here:
 *  - Search cannot be *forced*; `required` becomes an explicit instruction,
 *    `none` omits the tool entirely.
 *  - The model does not see URLs. Citations come from `groundingMetadata`
 *    (chunks + supports) and are inserted by the application after the text
 *    segment they support, so every link is one the search actually returned.
 */

const GEMINI_NOTES = `## Provider notes
- Your search tool is Google Search. Citations are attached automatically from your search results — do NOT write URLs or Markdown links yourself, and never invent sources.
- Keep each factual claim in its own sentence so its citation attaches precisely.`;

export interface GeminiRequest {
  model: string;
  contents: Content[];
  config: GenerateContentConfig;
}

function mergeTurns(turns: Array<{ role: "user" | "model"; text: string }>): Content[] {
  const out: Content[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.parts!.push({ text: t.text });
    else out.push({ role: t.role, parts: [{ text: t.text }] });
  }
  return out;
}

export function buildGeminiRequest(req: ModelRequest, cfg: Pick<AppConfig, "GEMINI_MODEL">): GeminiRequest {
  const finalUser = req.memoryContext ? `${req.memoryContext}\n\n<user_message>\n${req.user}\n</user_message>` : req.user;
  const contents = mergeTurns([
    ...req.history.map((t) => ({ role: t.role === "assistant" ? ("model" as const) : ("user" as const), text: t.content })),
    { role: "user", text: finalUser },
  ]);
  const mustSearch =
    req.toolChoice === "required"
      ? "\n\n## Search requirement\nYou MUST run Google Search for this answer and check current official sources for every item before answering."
      : "";
  const config: GenerateContentConfig = {
    systemInstruction: `${req.system}\n\n${GEMINI_NOTES}${mustSearch}`,
    temperature: 0.3,
    maxOutputTokens: 4096,
  };
  if (req.toolChoice !== "none") {
    const tools = [{ googleSearch: {} }];
    assertSingleSearchTool(tools);
    config.tools = tools;
  }
  // Gemini 2.5 uses a thinking *budget*: none for recall/chat, dynamic for change checks.
  if (/^gemini-2\.5/.test(cfg.GEMINI_MODEL)) {
    config.thinkingConfig = { thinkingBudget: req.toolChoice === "required" ? -1 : req.toolChoice === "auto" ? 1024 : 0 };
  }
  return { model: cfg.GEMINI_MODEL, contents, config };
}

function looksLikeDomain(s: string | undefined): s is string {
  return !!s && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.trim());
}

export function groundingSources(chunks: GroundingChunk[] | undefined): RawSource[] {
  const out: RawSource[] = [];
  for (const c of chunks ?? []) {
    const uri = c.web?.uri;
    if (!uri) continue;
    const title = c.web?.title ?? null;
    out.push({ url: uri, title, origin: "search", domain: looksLikeDomain(title ?? undefined) ? title!.toLowerCase() : c.web?.domain });
  }
  return out;
}

/**
 * Insert citation links after each supported segment. Segments are located by
 * their text (robust to byte/char offset differences); unmatched supports are
 * skipped rather than guessed.
 */
export function insertGroundingCitations(text: string, supports: GroundingSupport[] | undefined, sources: RawSource[]): string {
  if (!supports?.length || !sources.length) return text;
  const inserts: Array<{ at: number; md: string }> = [];
  let cursor = 0;
  for (const s of supports) {
    const seg = s.segment?.text?.trim();
    const idx = [...new Set(s.groundingChunkIndices ?? [])].filter((i) => sources[i]).slice(0, 2);
    if (!seg || idx.length === 0) continue;
    let pos = text.indexOf(seg, cursor);
    if (pos < 0) pos = text.indexOf(seg);
    if (pos < 0) continue;
    const end = pos + seg.length;
    cursor = end;
    const links = idx.map((i) => {
      const src = sources[i]!;
      const label = (src.domain || src.title || "source").replace(/[[\]]/g, "");
      return `[${label}](${src.url})`;
    });
    inserts.push({ at: end, md: ` (${links.join(", ")})` });
  }
  // Apply from the end so earlier offsets stay valid; skip duplicates at one spot.
  const seen = new Set<number>();
  let out = text;
  for (const ins of inserts.sort((a, b) => b.at - a.at)) {
    if (seen.has(ins.at)) continue;
    seen.add(ins.at);
    out = out.slice(0, ins.at) + ins.md + out.slice(ins.at);
  }
  return out;
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  readonly model: string;
  private ai: GoogleGenAI;
  constructor(private cfg: AppConfig) {
    this.model = cfg.GEMINI_MODEL;
    this.ai = new GoogleGenAI({ apiKey: cfg.GEMINI_API_KEY });
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const body = buildGeminiRequest(req, this.cfg);
    yield { type: "phase", phase: req.toolChoice === "none" ? "thinking" : "searching" };
    const stream = await this.ai.models.generateContentStream({ ...body, config: { ...body.config, abortSignal: signal } });
    let text = "";
    let writing = false;
    let chunks: GroundingChunk[] | undefined;
    let supports: GroundingSupport[] | undefined;
    let queries: string[] = [];
    for await (const chunk of stream) {
      const cand = chunk.candidates?.[0];
      const gm = cand?.groundingMetadata;
      if (gm?.groundingChunks?.length) chunks = gm.groundingChunks;
      if (gm?.groundingSupports?.length) supports = gm.groundingSupports;
      if (gm?.webSearchQueries?.length) queries = gm.webSearchQueries;
      // Only non-thought text parts are user-visible.
      const delta = (cand?.content?.parts ?? []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
      if (delta) {
        if (!writing) {
          writing = true;
          yield { type: "phase", phase: "writing" };
        }
        text += delta;
        yield { type: "text", delta };
      }
    }
    for (const q of queries) yield { type: "search", query: q };
    const sources = groundingSources(chunks);
    yield { type: "done", text: insertGroundingCitations(text, supports, sources), sources, searchQueries: queries };
  }

  async complete(system: string, user: string, signal: AbortSignal): Promise<string> {
    const res = await this.ai.models.generateContent({
      model: this.cfg.GEMINI_MODEL,
      contents: user,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        temperature: 0,
        abortSignal: signal,
        ...(/^gemini-2\.5/.test(this.cfg.GEMINI_MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    });
    return res.text ?? "";
  }
}
