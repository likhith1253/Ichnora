# Build notes

These are honest notes from building Minimi: what broke, what changed along the way, and what was worth learning.

## Picking a model and a search tool

The brief allowed one tool: web search. That sounded like the easy part. It wasn't.

1. **OpenAI.** This was the first plan, and it worked. But the project should run on a free key, without anyone having to add a card.
2. **Gemini with Google Search grounding.** On the free tier, grounded requests kept returning 429 errors, so search was effectively unavailable.
3. **Groq's built-in `browser_search`.** Its behaviour was hard to pin down, and there was no way to see which pages it had actually read. For a feature built around re-checking evidence, that was a dealbreaker.
4. **Groq + Tavily behind a custom `web_search` tool.** This is the final setup. Owning the tool means controlling the ranking (official pages first) and deciding which pages get read in full. It also gives every result a number the answer can cite. It took more work, but it turned out to be the most useful decision in the project.

## API key trouble

- **The key that wouldn't update.** After the Groq key in `.env.local` was replaced, every request still failed with "invalid key". The cause was an old `GROQ_API_KEY` set as a Windows system environment variable, which was quietly taking priority. The fix: `.env.local` now wins, it is re-read on every request, and `npm run probe` checks both keys without printing them.
- **Per-minute limit.** Groq's free tier allows about 8K tokens a minute. One research turn with search results could use most of that, and the next request would fail. A token gate now waits for the budget instead of erroring out.
- **Daily quota.** The final live runs hit the 200K-tokens-per-day cap. A fresh key didn't help, because the quota belongs to the organisation, not the key. Switching to a different account fixed it, but only after an evening lost to debugging.
- **Tavily credits.** The free plan gives 1,000 credits a month. A credit ledger with a reserve makes sure change checks, the feature that matters most, never run out because of casual searches.

## Model quirks

`gpt-oss-120b` is capable, but it has habits:

- It sometimes cites with its own `【…】` markers instead of the requested format. These are translated, and any link that doesn't match a URL the search actually returned is dropped.
- On the last round it sometimes tries to call the tool again instead of answering. Handing the final round its evidence as plain context fixed this.

## Architecture: over-built, then cut back

The first version had too much infrastructure: extra layers, abstractions and "just in case" code. It was hard to explain and harder to test, so most of it was removed. One rule replaced it: **anything that must be exactly right is plain code over SQLite; the model only reads and writes language.**

Dates, open loops, decision history and price comparisons all became deterministic and testable. That is where the 242 tests and the evaluation numbers come from.

A vector database was considered for memory. But the hard questions ("what did I ask on 3 November?", "what's overdue?") are structural, and SQL with FTS5 answers them exactly.

## Faster re-checks

Early CRM re-checks took about 103 seconds and 12K tokens, because the model spent a whole round deciding what to search. The app already knew the answer: the five products in the saved shortlist. Now the app plans those searches up front, and the model answers in one round. That cut it to about 48 seconds and 6K tokens.

## Security pass

Before submission, the code got an outsider-style review. The fixes:

- stricter cookie handling
- hashed session tokens
- PKCE and signed state for OAuth
- rate limits on the demo
- `X-Forwarded-For` trusted only behind a configured proxy

None of it is exciting, but all of it was worth doing.

## Lessons

- Build the evaluation early. It caught more bugs than manual testing did.
- Own the tool's output format. Verification is only possible when you know exactly what the model saw.
- Check environment variables before blaming the API.
