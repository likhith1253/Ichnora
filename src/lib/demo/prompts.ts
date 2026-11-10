/**
 * Guided prompts for the demo workspace. Each one showcases an existing
 * capability against the seeded data — date recall, a freshness re-check, a
 * cross-conversation change report, open loops and a decision history.
 */

export interface DemoPrompt {
  id: string;
  label: string;
  hint: string;
  text: string;
}

export const DEMO_PROMPTS: DemoPrompt[] = [
  {
    id: "recall",
    label: "Recall by date",
    hint: "Answered from memory, with no web search.",
    text: "What did I ask you on 3 November?",
  },
  {
    id: "verify",
    label: "Is it still true?",
    hint: "Re-checks the CRM shortlist and shows what changed.",
    text: "Is the CRM pricing shortlist from 9 November still correct today?",
  },
  {
    id: "changed",
    label: "Has any of it changed?",
    hint: "Compares two conversations and computes the differences.",
    text: "Has any of that pricing changed since I last asked?",
  },
  {
    id: "loops",
    label: "Open loops",
    hint: "Commitments, waiting items and tentative intentions.",
    text: "What commitments and open loops do I have right now?",
  },
  {
    id: "decision",
    label: "Decision history",
    hint: "Why the team moved from MongoDB to PostgreSQL.",
    text: "Why did we switch the database to PostgreSQL?",
  },
];

export function demoPromptTexts(): string[] {
  return DEMO_PROMPTS.map((p) => p.text);
}

/** Normalise a prompt so its cached answer can be reused verbatim. */
export function promptKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}
