import { and, count, desc, eq, gte } from "drizzle-orm";
import { aiQueries, db, sql } from "../../../db";
import type {
  AiRepository,
  AiSuccessRecord,
  WebsiteId,
} from "../interfaces/ai-repository.interface";
import type { AIHistoryItem } from "../interfaces/ai-query.types";

/** Hard timeout for AI-generated SQL. Bounds the cost of a runaway or expensive query. */
const AI_STATEMENT_TIMEOUT_MS = Number(process.env.AI_STATEMENT_TIMEOUT_MS ?? 8_000);

/**
 * `AiRepository` over Postgres.
 *
 * The only file in this module that touches `db`.
 */
export class PostgresAiRepository implements AiRepository {
  /**
   * The execution boundary for model-authored SQL.
   *
   * `transaction_read_only` is the enforcement that does not depend on parsing: however
   * the statement was written, it cannot write. `statement_timeout` bounds what it can
   * cost. Both are `SET LOCAL`, so they last exactly as long as this transaction.
   *
   * What neither of them does is stop a read of the wrong tenant — a `SELECT` against
   * another customer's rows is a perfectly valid read-only statement. That is
   * `validateAndSanitizeSQL`'s job, and it must have run before this is called.
   */
  async runGuarded(statement: string, boundId: string): Promise<Record<string, unknown>[]> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${AI_STATEMENT_TIMEOUT_MS}`);
      await tx.unsafe("SET LOCAL transaction_read_only = on");
      // `boundId` is a bound parameter, never interpolated into the statement.
      return (await tx.unsafe(statement, [boundId])) as Record<string, unknown>[];
    })) as Record<string, unknown>[];
  }

  async countQueriesSince(userId: string, since: Date): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(aiQueries)
      .where(and(eq(aiQueries.userId, userId), gte(aiQueries.createdAt, since)));
    return row?.n ?? 0;
  }

  async createPending(input: {
    userId: string;
    websiteUuid: string;
    prompt: string;
    model: string;
  }): Promise<string | null> {
    const [inserted] = await db
      .insert(aiQueries)
      .values({
        userId: input.userId,
        websiteId: input.websiteUuid,
        prompt: input.prompt,
        model: input.model,
        status: "pending",
      })
      .returning({ id: aiQueries.id });
    return inserted?.id ?? null;
  }

  async markSuccess(id: string, record: AiSuccessRecord): Promise<void> {
    await db
      .update(aiQueries)
      .set({ ...record, status: "success" })
      .where(eq(aiQueries.id, id));
  }

  async markFailure(
    id: string,
    record: { errorMessage: string; executionTimeMs: number },
  ): Promise<void> {
    await db
      .update(aiQueries)
      .set({ ...record, status: "error" })
      .where(eq(aiQueries.id, id));
  }

  async countSuccessfulSince(userId: string, since: Date): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(aiQueries)
      .where(
        and(
          eq(aiQueries.userId, userId),
          eq(aiQueries.status, "success"),
          gte(aiQueries.createdAt, since),
        ),
      );
    return row?.n ?? 0;
  }

  async history(userId: string, websiteId: WebsiteId, limit: number): Promise<AIHistoryItem[]> {
    const rows = await db
      .select({
        id: aiQueries.id,
        prompt: aiQueries.prompt,
        title: aiQueries.title,
        viz_type: aiQueries.vizType,
        status: aiQueries.status,
        created_at: aiQueries.createdAt,
      })
      .from(aiQueries)
      .where(and(eq(aiQueries.userId, userId), eq(aiQueries.websiteId, websiteId)))
      .orderBy(desc(aiQueries.createdAt))
      .limit(Math.min(limit, 20));

    return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
  }
}
