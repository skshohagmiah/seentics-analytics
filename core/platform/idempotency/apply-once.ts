import { sql as raw } from "drizzle-orm";
import type { TransactionSql } from "postgres";
import { db, sql } from "../../db";

/**
 * The transaction a guarded write runs in.
 *
 * Exported because every repository called through `applyBatchOnce` must take it as a
 * parameter rather than reaching for the ambient `db` — that is the difference between
 * the write sharing the marker's transaction and silently escaping it.
 */
export type BatchTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What a write reports back, so the caller can tell a fresh apply from a repeat. */
export type BatchApplication = {
  /** `false` when this batch had already been applied and nothing was written. */
  applied: boolean;
  /** Rows written on a fresh apply; 0 on a repeat. */
  rowCount: number;
};

/**
 * Run a write exactly once for a given batch id, however many times it is delivered.
 *
 * The queue row **is** the marker. Completing it and doing the write share one
 * transaction, so they commit together or not at all: there is no window where a batch
 * looks applied but its rows are missing. A redelivery finds `completed_at` already set,
 * matches zero rows, and `write` is never called.
 *
 * This used to be a second table, `ingest_batches` recording delivery and
 * `ingest_applied_batches` recording application — two rows, two prunes and two concepts
 * for one fact. Merging them costs nothing: the completion flip simply moved inside the
 * transaction it should always have been in.
 *
 * Why it is needed at all: two of the six writes accumulate rather than insert —
 * `intensity = intensity + EXCLUDED.intensity` and `visit_count + …` — so a repeat
 * corrupts a number instead of duplicating a row, and no per-row id can express "this
 * contribution was already added" to an aggregate that has no per-row identity.
 *
 * `write` receives the transaction and **must** use it. Writing through the ambient `db`
 * instead would put the rows outside the transaction and reintroduce the double-write
 * this exists to prevent.
 *
 * Object storage is deliberately outside the guarantee: puts are keyed by content or by
 * (session, sequence), so replaying one overwrites rather than duplicates. Only the
 * database effects need the marker.
 */
export async function applyBatchOnce(
  batchId: string,
  write: (tx: BatchTx) => Promise<number>,
): Promise<BatchApplication> {
  return db.transaction(async (tx) => {
    // Also clears the claim: the batch is done, and leaving a lease on a completed row
    // would keep its partition key occupied until the lease expired.
    const claimed = await tx.execute(raw`
      UPDATE ingest_batches
         SET completed_at = NOW(), claimed_at = NULL
       WHERE batch_id = ${batchId}
         AND completed_at IS NULL
      RETURNING batch_id
    `);

    // No row means one of two things, and both want the same answer. Either another
    // worker already applied this batch, or it never reached the queue — a direct caller
    // that made up a batch id. Skipping is right for the first; the second is a
    // programming error the `queued` guard below names.
    if ([...claimed].length === 0) return { applied: false, rowCount: 0 };

    return { applied: true, rowCount: await write(tx) };
  });
}

/**
 * `applyBatchOnce` for writers that use the raw tagged-template client.
 *
 * Drizzle and `sql` share one `postgres` client but not one transaction object, so a
 * repository built on raw SQL cannot enlist in the Drizzle transaction above — it would
 * run on a separate connection and commit independently, which is precisely the hole the
 * marker exists to close. This uses `sql.begin` so the completion flip and the write share
 * a transaction on the client the writer already has.
 *
 * The heatmap upsert is the reason this exists. Its `intensity = intensity +
 * EXCLUDED.intensity` is the least forgiving write in the system: a replayed batch does
 * not duplicate a row, it inflates a number, with nothing to distinguish the result from
 * real traffic.
 */
export async function applyBatchOnceSql(
  batchId: string,
  write: (tx: TransactionSql) => Promise<number>,
): Promise<BatchApplication> {
  const result = await sql.begin(async (tx) => {
    const claimed = await tx`
      UPDATE ingest_batches
         SET completed_at = NOW(), claimed_at = NULL
       WHERE batch_id = ${batchId}
         AND completed_at IS NULL
      RETURNING batch_id
    `;

    if (claimed.length === 0) return { applied: false, rowCount: 0 };

    return { applied: true, rowCount: await write(tx) };
  });
  return result as unknown as BatchApplication;
}
