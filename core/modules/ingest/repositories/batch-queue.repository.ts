import { and, eq, isNotNull, isNull, lt, sql as raw } from "drizzle-orm";
import { db, ingestBatches, sql } from "../../../db";
import type { IngestLane, QueuedBatch } from "../interfaces";

/**
 * The durable queue, in Postgres.
 *
 * One naming seam to know about: the table's column is `category` and the code calls it
 * `lane`. The column is older than the rename and holds the same six values; renaming it
 * would mean a migration that has to land in lockstep with a deploy, on the one table that
 * is holding undelivered work while it happens. Not worth it for a word.
 *
 * Modelled on `platform/outbox/outbox-repository.ts` — same claim-and-park shape,
 * whose failure modes the team has already reasoned about — with one difference that
 * matters: a claim here is a written lease, not a row lock. See `claimPendingBatches`.
 */

/**
 * How long a claim is honoured before another worker may take the batch.
 *
 * Sized for the slowest sink rather than the average one: a heatmap batch can spend a
 * while in S3 puts, and re-claiming a batch that is still being applied is only safe
 * because the apply's own transaction completes the row — for recordings it would also break the
 * per-session chunk ordering the partition key exists to protect. Long enough that only a
 * genuinely dead worker hits it; short enough that its batches are not stranded for the
 * rest of the day.
 */
export const CLAIM_LEASE_MS = 5 * 60_000;

/** Postgres `unique_violation`. See the claim query. */
const UNIQUE_VIOLATION = "23505";

/**
 * Add a batch to the queue.
 *
 * `ON CONFLICT DO NOTHING` on the content-derived id makes enqueue itself idempotent, so
 * a flush that fails *after* writing the row and retries does not queue the batch twice.
 */
export async function enqueueBatch(batch: {
  batchId: string;
  lane: IngestLane;
  partitionKey: string;
  /** Already serialized by the producer — see `BatchQueue.enqueue`. */
  payloadJson: string;
  rowCount: number;
}): Promise<void> {
  // Raw rather than `db.insert(...).values(...)`: the payload arrives as text and is cast
  // straight to jsonb, so the driver never re-serializes a batch the producer has already
  // serialized once to derive its id.
  await sql`
    INSERT INTO ingest_batches (batch_id, category, partition_key, payload, row_count)
    VALUES (${batch.batchId}, ${batch.lane}, ${batch.partitionKey}, ${batch.payloadJson}::jsonb, ${batch.rowCount})
    ON CONFLICT (batch_id) DO NOTHING
  `
}

/**
 * Claim pending batches of one category, oldest first, by writing a lease.
 *
 * **The claim is `claimed_at`, not a lock.** It has to be. This runs through `db.execute`,
 * which is a single autocommit statement, so any `FOR UPDATE` it takes is released the
 * instant the statement returns — before the caller has applied anything. The previous
 * version relied on exactly that lock to mean "claimed", and so claimed nothing: two
 * workers would take the same row, and two batches for one partition key would be applied
 * concurrently. The completion marker hid the first problem for
 * analytics, funnels, automations and heatmaps. Recordings had no such cover — chunk
 * sequences are assigned per session, and two concurrent batches for one session overwrite
 * each other's chunks in object storage.
 *
 * So the whole thing is one atomic `UPDATE … RETURNING`. A row that comes back has its
 * lease written and committed; nothing else can select it until the lease expires.
 *
 * Three parts, in order:
 *
 * - `leased` is the set of partition keys with a batch currently in flight. Excluding them
 *   is what keeps ordering within a key: the next batch for a session waits for the
 *   current one rather than running beside it.
 * - `candidates` takes the oldest pending batch per remaining key. `DISTINCT ON` cannot
 *   carry `FOR UPDATE` — Postgres rejects the combination, and an earlier version that
 *   asked for both threw on every poll — which is the other reason the lock could not have
 *   been the claim here even in a transaction.
 * - `oldest` reapplies age ordering and bounds the poll. The `LIMIT` belongs here and not
 *   in `candidates`: `DISTINCT ON` must sort by its own key, so limiting inside it would
 *   take the twenty alphabetically-lowest partition keys every single poll and starve
 *   every key above them for as long as those twenty kept producing.
 * - the `UPDATE` re-checks the lease on the row it is about to take. Under READ COMMITTED a
 *   worker that blocks on a row another has just claimed re-evaluates this predicate
 *   against the new version, finds the lease set, and returns nothing for it. `SKIP LOCKED`
 *   means it does not wait to find that out.
 *
 * `ix_ingest_batches_pending` is what keeps `candidates` affordable without a `LIMIT`: it
 * is ordered `(category, partition_key, created_at)` and partial on `completed_at IS NULL`,
 * so `DISTINCT ON` reads it in the order it already wants and needs no sort. It still walks
 * the whole backlog for the category — on 40k pending batches that measured 10ms against
 * the old index's 26ms and 3.7MB sort — so a backlog that never drains is still a backlog,
 * and `countParked` is the thing to alert on.
 */
export async function claimPendingBatches(
  lane: IngestLane,
  limit: number,
  maxAttempts: number,
): Promise<QueuedBatch[]> {
  const leaseMs = CLAIM_LEASE_MS;
  try {
    const rows = await db.execute<{
      batch_id: string;
      category: string;
      partition_key: string;
      payload: { rows: unknown[] };
      row_count: number;
      attempts: number;
    }>(raw`
      WITH leased AS (
        SELECT partition_key
        FROM ingest_batches
        WHERE category = ${lane}
          AND completed_at IS NULL
          AND claimed_at IS NOT NULL
          AND claimed_at > now() - ${leaseMs} * interval '1 millisecond'
      ),
      candidates AS (
        SELECT DISTINCT ON (b.partition_key) b.batch_id, b.created_at
        FROM ingest_batches b
        WHERE b.category = ${lane}
          AND b.completed_at IS NULL
          AND b.attempts < ${maxAttempts}
          AND NOT EXISTS (SELECT 1 FROM leased l WHERE l.partition_key = b.partition_key)
        ORDER BY b.partition_key, b.created_at ASC
      ),
      oldest AS (
        SELECT batch_id FROM candidates ORDER BY created_at ASC LIMIT ${limit}
      ),
      locked AS (
        SELECT batch_id
        FROM ingest_batches
        WHERE batch_id IN (SELECT batch_id FROM oldest)
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ingest_batches t
      SET claimed_at = now()
      FROM locked l
      WHERE t.batch_id = l.batch_id
        AND t.completed_at IS NULL
        AND (t.claimed_at IS NULL OR t.claimed_at <= now() - ${leaseMs} * interval '1 millisecond')
      RETURNING t.batch_id, t.category, t.partition_key, t.payload, t.row_count, t.attempts
    `);

    return [...rows].map((r) => ({
      batchId: r.batch_id,
      lane: r.category as IngestLane,
      partitionKey: r.partition_key,
      payload: r.payload as { rows: unknown[] },
      rowCount: r.row_count,
      attempts: r.attempts,
    }));
  } catch (err) {
    // `ux_ingest_batches_one_inflight` firing means another worker claimed a sibling batch
    // of the same partition between this statement's snapshot and its write. That is the
    // constraint doing its job, not an outage: claim nothing and let the next tick pick up
    // whatever is still free. Reporting it as a failure would trip the worker's backoff.
    if (isUniqueViolation(err)) return [];
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Record a failed attempt and release the lease.
 *
 * The row stays pending, so the next tick retries it — immediately, rather than after the
 * lease expires, which is what clearing `claimed_at` buys. Once `attempts` reaches the cap
 * the claim query stops returning it and the batch is parked: visible to `countParked`,
 * replayable by resetting `attempts`, and never silently dropped the way the in-memory
 * flush drops a batch after three tries. A parked batch holds no lease, so it cannot block
 * its partition key.
 */
export async function markBatchFailed(batchId: string, error: string): Promise<void> {
  await db
    .update(ingestBatches)
    .set({
      attempts: raw`${ingestBatches.attempts} + 1`,
      lastError: error.slice(0, 2000),
      claimedAt: null,
    })
    .where(eq(ingestBatches.batchId, batchId));
}

/**
 * Give a claimed batch back without counting an attempt.
 *
 * For batches a worker claimed and then did not get to — a shutdown mid-drain is the only
 * caller. Leaving them leased would strand each one, and its whole partition key behind it,
 * until the lease expired.
 */
export async function releaseBatchClaims(batchIds: string[]): Promise<void> {
  if (batchIds.length === 0) return;
  await db
    .update(ingestBatches)
    .set({ claimedAt: null })
    .where(and(isNull(ingestBatches.completedAt), raw`batch_id = ANY(${batchIds})`));
}

/** Pending batches in one lane — the queue depth a health check reports. */
export async function countPendingBatches(
  lane: IngestLane,
  maxAttempts: number,
): Promise<number> {
  const [row] = await db
    .select({ n: raw<number>`count(*)::int` })
    .from(ingestBatches)
    .where(
      and(
        eq(ingestBatches.category, lane),
        isNull(ingestBatches.completedAt),
        lt(ingestBatches.attempts, maxAttempts),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Batches that exhausted their attempts — the dead-letter count.
 *
 * Worth alerting on: unlike a pending backlog, this never drains on its own.
 */
export async function countParkedBatches(maxAttempts: number): Promise<number> {
  const [row] = await db
    .select({ n: raw<number>`count(*)::int` })
    .from(ingestBatches)
    .where(and(isNull(ingestBatches.completedAt), raw`attempts >= ${maxAttempts}`));
  return row?.n ?? 0;
}

/** Drop applied batches older than the retention window. */
export async function pruneCompletedBatches(olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(ingestBatches)
    .where(and(isNotNull(ingestBatches.completedAt), lt(ingestBatches.completedAt, olderThan)))
    .returning({ batchId: ingestBatches.batchId });
  return deleted.length;
}
