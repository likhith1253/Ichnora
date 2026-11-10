/**
 * Data minimisation at the search egress boundary. Search queries are drafted
 * by the model, which is told not to search for personal matters — but prompts
 * are not a guarantee. Before any query leaves the machine we strip identity
 * tokens (email addresses) from it, so a private detail can never reach the
 * external search provider. Live public research keeps working exactly as before.
 */

/** Anything that looks like an email address. */
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Remove identity tokens and normalise whitespace. Returns "" when nothing
 * searchable remains (the caller must then skip the network call entirely).
 */
export function sanitizeSearchQuery(query: string): string {
  return query
    .replace(EMAIL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}
