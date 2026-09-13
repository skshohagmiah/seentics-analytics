import type { UsageCounter, UsageScope } from "../../../platform/usage";
import type { AiRepository } from "../interfaces/ai-repository.interface";

/**
 * Successful AI analyses this calendar month.
 *
 * Keyed by user rather than by website: an AI query is billed to the person who ran
 * it, and the daily limit in `natural-language-query.service.ts` is enforced the same way. Only
 * `status = 'success'` counts — a failed LLM call is not charged.
 */
export class AiUsageCounter implements UsageCounter {
  readonly key = "ai_analyses";

  constructor(private readonly repo: AiRepository) {}

  async countForUser(scope: UsageScope): Promise<number> {
    return this.repo.countSuccessfulSince(scope.userId, scope.monthStart);
  }
}
