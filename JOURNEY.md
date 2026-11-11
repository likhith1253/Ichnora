# How we built Minimi

These are notes on what actually happened while building this: what broke, what we changed our minds about, and what we learned. They aren't polished. They're just the honest version.

## Picking a model and a search tool (this took longer than expected)

The rule was one tool: web search. We assumed that part would be easy.

1. **OpenAI.** This was the first plan. It worked, but we wanted something anyone could run on a free key without adding a card.
2. **Gemini.** Next we tried Gemini with Google Search grounding. On the free tier, grounded requests kept coming back as 429s, so search effectively wasn't available to us.
3. **Groq's built-in `browser_search`.** We were never sure how it behaved, and we couldn't see which pages it had actually read. That mattered, because the whole point of a re-check is showing evidence.
4. **Groq + Tavily, with our own `web_search` tool.** This is where we landed. Because we own the tool, we control ranking (official pages first), we decide which pages to read in full, and every result gets a number the answer can cite. It was more work, but it turned out to be the single most useful decision in the project.

## API key problems

- **The key that wouldn't update.** At one point we changed the Groq key in `.env.local` and kept getting "invalid key". It turned out an old `GROQ_API_KEY` was set as a Windows system environment variable, and it was silently winning. Now `.env.local` takes priority and is re-read on every request, and `npm run probe` checks both keys without printing them.
- **Rate limits.** Groq's free tier allows about 8K tokens per minute. A single research turn with search results could use most of that, and the next request would fail. We added a token gate that waits for the budget instead of erroring out.
- **Daily quota.** During the final live runs we hit the 200K-tokens-per-day limit. Creating a new key didn't help, because the quota is per organisation, not per key. Running from a different account fixed it. It was a small lesson, but we lost an evening to it.
- **Tavily credits.** There are 1,000 credits a month. We added a credit ledger and a reserve so change checks (the feature that matters most) never get starved by casual searches.

## Model quirks

`gpt-oss-120b` is good, but it has habits:

- It sometimes cites sources with its own `【…】` markers instead of the format we asked for. We translate those, and any link that doesn't match a URL we actually returned is dropped.
- On the last round it sometimes tries to call the tool again instead of answering. Giving the final round its evidence as plain context fixed this.

## Architecture: we over-built first

Our first version had a lot of infrastructure: more layers, more abstractions and more "just in case" code than the problem needed. It was hard to explain, and harder to test. We removed most of it and kept a simple rule: **anything that must be exactly right is plain code over SQLite, and the model only reads and writes language.** Dates, open loops, decision history and price comparisons all became deterministic and testable. That is why there are 242 tests and why the eval numbers are what they are.

We also considered a vector database for memory. We realised the hard questions ("what did I ask on 3 November?", "what's overdue?") are structural, and SQL with FTS5 handles them exactly.

## Making re-checks faster

Early CRM re-checks took about 103 seconds and 12K tokens, because the model spent a whole round deciding what to search. But the app already knows what to search: the five products in the saved shortlist. So now the app plans those searches up front, and the model answers in one round. That brought it down to about 48 seconds and 6K tokens.

## Security pass

Before submitting, we reviewed the code like an outsider would. We tightened cookie handling, used hashed session tokens, added PKCE and signed state for OAuth, put rate limits on the demo, and made `X-Forwarded-For` trusted only behind a proxy we configure. None of it is exciting, but it was worth doing.

## What we'd tell ourselves at the start

- Build the evaluation early. It caught more bugs than manual testing did.
- Own your tool's output format. Verification is only possible if you know exactly what the model saw.
- Check environment variables before blaming the API.
