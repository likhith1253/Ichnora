# Ichnora — Design

Ichnora is a personal knowledge and research assistant that **remembers what you asked and when**, and can tell you whether an earlier answer still holds. It uses one model (Groq `gpt-oss-120b`) and exactly one tool, `web_search`. Everything that must be *exactly right* (dates, history, commitments, sources, price comparisons) is handled by deterministic, tested application code over SQLite. The model's job is to understand the question and write a clear answer.

> **Reading guide:** start with the overview below. Each numbered part has a **details** link that jumps to its section. Click the grey <kbd>▶ click to expand</kbd> button (or anywhere on that line) to open the deep dive and its diagram.

## 1. Overview

```mermaid
flowchart LR
  U(["👤 User"]):::user --> A["① Chat API"]:::core --> M["② Memory"]:::memory --> R{"③ Router"}:::core
  R -- "recall · open loops" --> G["⑤ Agent<br/>gpt-oss-120b"]:::llm
  R -- "has it changed?" --> P["④ Planner"]:::research --> G
  R -- "new research" --> G
  G <-- "web_search<br/>(only tool)" --> T["⑥ Search pipeline"]:::research
  G --> V["⑦ Evidence check"]:::verify --> U
  M <--> DB[("SQLite + FTS5")]:::store
  V --> DB
  T <--> TAV[["Tavily"]]:::ext
  G <--> GQ[["Groq"]]:::ext

  classDef user fill:#1f2937,stroke:#111827,color:#fff
  classDef core fill:#e0e7ff,stroke:#4f46e5,color:#1e1b4b
  classDef memory fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef research fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef llm fill:#ede9fe,stroke:#7c3aed,color:#3b0764
  classDef verify fill:#fce7f3,stroke:#db2777,color:#831843
  classDef store fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef ext fill:#f3f4f6,stroke:#6b7280,color:#111827
```

| # | Component | One line | Deep dive |
|---|---|---|---|
| ① | Chat API | Streams each turn over SSE. Retried requests are idempotent. | [**▶ open**](#c1) |
| ② | Memory engine | Exact recall by date or topic, commitments and decisions. | [**▶ open**](#c2) |
| ③ | Router | Decides whether a question needs the web at all. | [**▶ open**](#c3) |
| ④ | Search planner | Pre-builds one search per product for change checks. | [**▶ open**](#c4) |
| ⑤ | Agent loop | One model, one tool, at most 3 rounds, token-paced. | [**▶ open**](#c5) |
| ⑥ | Search pipeline | Search, rank official pages first, read the best ones in full. | [**▶ open**](#c6) |
| ⑦ | Evidence check | Verifies citations and computes Then → Now in code. | [**▶ open**](#c7) |

## 2. Zoom in

<a id="c1"></a>
<details open>
<summary><b>① Chat API</b>: one turn, streamed end to end &nbsp;<kbd>▶ click to expand</kbd></summary>

```mermaid
sequenceDiagram
  participant U as User
  participant API as Chat API
  participant App as Memory + Router
  participant LLM as Groq agent
  participant W as web_search
  U->>API: POST /api/chat (requestId)
  API->>App: retrieve memory, pick intent
  API-->>U: SSE start (intent, memory used)
  App->>LLM: question + labelled memory
  LLM->>W: web_search(queries)
  W-->>LLM: numbered evidence [1..n]
  LLM-->>API: answer tokens
  API-->>U: SSE delta, delta, ...
  API-->>U: SSE done (sources, Then/Now)
```

- Turns are serialised per conversation, and a repeated `requestId` replays the stored answer instead of running again.
- Messages are immutable, with a UTC timestamp, the timezone and the local date.
</details>

<a id="c2"></a>
<details>
<summary><b>② Memory engine</b>: what you asked, promised and decided &nbsp;<kbd>▶ click to expand</kbd></summary>

```mermaid
flowchart LR
  T["Your message"] --> C{"Classify<br/>(rules)"}
  C --> CM["Commitment<br/>due Friday"]:::memory
  C --> IN["Intention<br/>'might email'"]:::memory
  C --> DE["Decision<br/>supersedes earlier"]:::memory
  C --> RS["Research snapshot<br/>dated prices"]:::research
  CM & IN & DE & RS --> DB[("SQLite<br/>quote · date · source")]:::store
  classDef memory fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef research fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef store fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
```

- **Retrieval:** SQL handles dates and statuses, FTS5 handles topics, and scoring resolves references like "them" to an earlier shortlist.
- **Provenance:** every memory keeps the user's original quote. "I sent it" closes the matching commitment and links the evidence.
</details>

<a id="c3"></a>
<details>
<summary><b>③ Router</b>: search only when it adds something &nbsp;<kbd>▶ click to expand</kbd></summary>

| Intent | Example | Tool policy |
|---|---|---|
| chat | "thanks!" | none |
| recall | "What did I ask on 3 November?" | none |
| open_loops | "What's pending?" | none |
| decision_history | "How has my database choice changed?" | none |
| recall_and_verify | "Has any of them changed?" | **required** |
| research | "Compare Postgres hosts" | model decides |

Routing is deterministic and tested, with 0 unnecessary searches in the evaluation suite.
</details>

<a id="c4"></a>
<details>
<summary><b>④ Search planner</b>: five products, one model round &nbsp;<kbd>▶ click to expand</kbd></summary>

```mermaid
flowchart LR
  S["Monday's snapshot<br/>HubSpot, Pipedrive, Zoho, ..."]:::memory --> P["Planner"]:::research
  P --> Q1["HubSpot pricing 2026"] & Q2["Pipedrive pricing 2026"] & Q3["... × 5"]
  Q1 & Q2 & Q3 --> E["Evidence ready<br/>before the model starts"]:::verify
  classDef memory fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef research fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef verify fill:#fce7f3,stroke:#db2777,color:#831843
```

The app already knows what a re-check needs, so it runs those searches first. Measured live: a CRM re-check went from **103 s / 12.4K tokens to 48.5 s / 6.0K tokens**, in one model round.
</details>

<a id="c5"></a>
<details>
<summary><b>⑤ Agent loop</b>: one model, one tool, bounded &nbsp;<kbd>▶ click to expand</kbd></summary>

- At most 3 rounds. The final round receives the evidence as plain context, so the model writes an answer instead of calling the tool again.
- A token gate paces requests under Groq's 8K tokens-per-minute free tier, so a burst of questions waits instead of failing.
- Reasoning effort is `low` by default and `medium` for change checks.
</details>

<a id="c6"></a>
<details>
<summary><b>⑥ Search pipeline</b>: inside the single <code>web_search</code> tool &nbsp;<kbd>▶ click to expand</kbd></summary>

```mermaid
flowchart LR
  Q["≤ 5 queries"] --> S["Tavily search"]:::ext --> R["Rank<br/>official domain ·<br/>page type · freshness"]:::research --> X["Read top pages<br/>in full (≤ 3)"]:::research --> N["Numbered evidence<br/>[1] official · full page<br/>[2] third-party · snippet"]:::verify
  classDef research fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef verify fill:#fce7f3,stroke:#db2777,color:#831843
  classDef ext fill:#f3f4f6,stroke:#6b7280,color:#111827
```

A credit ledger tracks Tavily's 1,000 monthly credits and keeps a reserve for change checks.
</details>

<a id="c7"></a>
<details>
<summary><b>⑦ Evidence check</b>: citations and Then → Now, computed in code &nbsp;<kbd>▶ click to expand</kbd></summary>

```mermaid
flowchart LR
  A["Answer cites [n]"] --> M{"n was<br/>returned?"}
  M -- yes --> L["Link to exact URL"]:::verify
  M -- no --> X["Removed"]:::bad
  O["Then: $15/user/mo<br/>Now: $20/user/mo"] --> C["Compare like with like<br/>(currency · period · plan)"]:::research --> V["CHANGED"]:::verify
  classDef verify fill:#fce7f3,stroke:#db2777,color:#831843
  classDef research fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
```

Each item gets one of three verdicts: **CHANGED**, **NO MATERIAL CHANGE FOUND** or **UNABLE TO VERIFY**. Missing evidence is never read as "no change".
</details>

## 3. The three example questions

| Question | What happens | Web search? |
|---|---|---|
| *"What did I ask you on 3 November? Is your answer still correct today?"* | The date is resolved in the user's timezone, and the question comes back word for word with its saved answer and sources. Those sources are then re-checked. | Recall: no. Re-check: yes |
| *"On Monday we shortlisted 5 CRM tools… Has any of them changed?"* | "Them" is resolved to Monday's shortlist. The planner searches each product, and the app compares prices line by line. | Yes, planned |
| *"Last Tuesday I asked about Postgres hosting. Has pricing changed?"* | The conversation is found by date and topic, and its prices become the baseline. | Yes, planned |

## 4. Key decisions and alternatives

| Decision | Instead of | Why |
|---|---|---|
| Memory in application code | Memory as a second tool | Keeps the one-tool rule and saves a model round-trip on every turn. |
| SQL + FTS5 | Vector database | "On 3 November" and "overdue" are exact questions, and SQL answers them exactly. |
| Own `web_search` over Tavily | Gemini grounding, Groq `browser_search` | Works on free tiers and keeps the source details needed for verification. |
| Then → Now computed in code | Model judges what changed | Same evidence always gives the same verdict, and it is testable. |
| Single bounded agent | Planner/critic multi-agent | Fewer tokens, lower latency, the same answer quality. |
| No search-result cache | Caching | A cached result can't answer "is it still correct today?". |

## 5. Results

- **Deterministic suite:** 242 tests, plus a labelled evaluation suite ([EVALUATION.md](EVALUATION.md)):
  - commitment extraction: 100% precision and recall
  - routing: 100% correct intent
  - dates: 14/14 correct across timezones
  - change detection: 10/10 correct verdicts
- **Live:** all three example questions pass end to end against real Groq and Tavily ([eval/live.md](eval/live.md)).

## 6. With another week

- Target each vendor's official domain in planned re-checks.
- Have the model return then/now values as schema-validated JSON.
- Add rolling summaries for long conversations.
- Use small local embeddings for paraphrased recall ("that database thing").
