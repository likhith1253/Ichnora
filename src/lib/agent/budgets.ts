export interface TurnExecutionBudget {
  maxRounds: number;            // Default: 3
  maxSearchQueries: number;     // Default: 5
  maxExtractions: number;       // Default: 3
  maxPromptTokens: number;      // Default: 6000 (safely within 8K TPM)
  maxCompletionTokens: number;  // Default: 2000
  timeoutMs: number;            // Default: 120_000 (2 minutes)
}

export const DEFAULT_TURN_BUDGET: TurnExecutionBudget = {
  maxRounds: 3,
  maxSearchQueries: 5,
  maxExtractions: 3,
  maxPromptTokens: 6000,
  maxCompletionTokens: 2000,
  timeoutMs: 120_000,
};

export class ExecutionBudgetTracker {
  roundsUsed = 0;
  queriesUsed = 0;
  extractionsUsed = 0;
  promptTokensUsed = 0;
  completionTokensUsed = 0;

  constructor(readonly budget: TurnExecutionBudget = DEFAULT_TURN_BUDGET) {}

  canRunMoreRounds(): boolean {
    return this.roundsUsed < this.budget.maxRounds;
  }

  remainingQueries(): number {
    return Math.max(0, this.budget.maxSearchQueries - this.queriesUsed);
  }

  remainingExtractions(): number {
    return Math.max(0, this.budget.maxExtractions - this.extractionsUsed);
  }

  recordRound(usage?: { promptTokens?: number; completionTokens?: number }): void {
    this.roundsUsed++;
    if (usage?.promptTokens) this.promptTokensUsed += usage.promptTokens;
    if (usage?.completionTokens) this.completionTokensUsed += usage.completionTokens;
  }

  recordQueries(count: number): void {
    this.queriesUsed += count;
  }

  recordExtractions(count: number): void {
    this.extractionsUsed += count;
  }
}

