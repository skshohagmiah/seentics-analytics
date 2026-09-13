import type { AIDomain, AIHistoryItem, AIQueryResult } from "./ai-query.types";

/**
 * The ai module's public surface.
 *
 * The module owns `ai_queries` (prompt history and per-day quota accounting) and
 * nothing else. Everything it reports on — analytics, funnels, heatmaps,
 * automations, revenue — belongs to other modules; it reaches that data by
 * generating SQL against an allow-listed set of tables per domain, which is why the
 * domain prompts live under `services/domains/` and carry their own table lists.
 */

export type { AIDomain, AIHistoryItem, AIQueryResult };

/** Raised when the authenticated user has exhausted the daily AI allowance. */
export class AIDailyLimitError extends Error {
  constructor(message = "AI daily query limit reached") {
    super(message);
    this.name = "AIDailyLimitError";
  }
}

/**
 * Natural-language querying.
 *
 * `runQuery` is the expensive path: it makes at least one LLM call, generates SQL,
 * and executes it. Quota is enforced inside rather than by the caller, so no route
 * can accidentally skip it — exceeding it raises `AIDailyLimitError`.
 */
export interface AiQueryExecution {
  run(
    userId: string,
    websiteRef: string,
    prompt: string,
    domain?: AIDomain | "auto",
  ): Promise<AIQueryResult>;

}

export interface AiQueryHistory {
  /** Recent prompts for this user and website, newest first. */
  history(userId: string, websiteId: string, limit?: number): Promise<AIHistoryItem[]>;
}

export type AiQuery = AiQueryExecution & AiQueryHistory;
