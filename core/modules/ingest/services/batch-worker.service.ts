import type { Logger } from "../../../platform/lib/logger";
import type { BatchQueue, IngestLane, LaneRegistry, QueuedBatch } from "../interfaces";

export type BatchWorkerOptions = {
  /** Batches claimed per lane per tick. */
  batchSize?: number;
  /** Delay between ticks when the last one found nothing. */
  idleIntervalMs?: number;
  /** Attempts before a batch is parked for inspection rather than retried forever. */
  maxAttempts?: number;
  /** How long applied batches are kept before pruning. */
  retainCompletedMs?: number;
};

/** Ceiling for the claim-failure backoff. Long enough to stay quiet, short enough to recover promptly. */
const MAX_CLAIM_BACKOFF_MS = 30_000;

const DEFAULTS: Required<BatchWorkerOptions> = {
  batchSize: 20,
  idleIntervalMs: 250,
  maxAttempts: 5,
  retainCompletedMs: 6 * 60 * 60 * 1000,
};

/**
 * Drains the durable queue into each lane's own write.
 *
 * The counterpart to `CollectBuffer`: that side batches and enqueues, this side
 * claims and applies. Splitting them is what makes the pipeline survive a restart — the
 * batch is a committed row before any write is attempted, so a crash costs at most the
 * batches currently in flight instead of every in-memory buffer.
 *
 * Each lane is polled independently, and that isolation is the point. Heatmaps is the
 * slowest consumer by a wide margin — aggregating upserts plus Playwright captures — and
 * in the single-flush design its slowness delayed analytics writes for every site. Here a
 * stalled heatmap lane drains at its own pace while analytics keeps up.
 *
 * A failed batch is retried, then **parked**, never dropped. The in-memory flush drops a
 * batch after three attempts with a log line, which is defensible when the whole window is
 * milliseconds and indefensible once the batch is a durable row you could have replayed.
 *
 * Claiming writes a lease rather than holding a lock — see `claimPendingBatches`. What that
 * costs this side is the obligation to give a claim back: the apply's own transaction and `markFailed`
 * both clear it, and `drainLane` releases anything a shutdown left unapplied.
 */
export class BatchWorker {
  private readonly log: Logger;
  private readonly opts: Required<BatchWorkerOptions>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private stopped = false;

  private appliedCount = 0;
  private failedCount = 0;
  private lastPruneAt = 0;

  /**
   * Consecutive ticks where claiming failed outright.
   *
   * Drives an exponential backoff, and suppresses the log after the first. A claim
   * failure means the database is unreachable or the table is missing — conditions that
   * persist — so retrying at the idle interval produced twenty identical lines per second
   * across five lanes and buried everything else in the log.
   */
  private claimFailures = 0;

  constructor(
    private readonly store: BatchQueue,
    /** Every lane's spec, keyed by name — see `LaneSpec`. */
    private readonly registry: LaneRegistry,
    logger: Logger,
    options: BatchWorkerOptions = {},
  ) {
    this.log = logger.child({ category: "ingest_worker" });
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Begin polling. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.schedule(0);
  }

  /**
   * Stop polling and wait for the current tick to finish.
   *
   * Awaiting matters: a batch in flight is mid-apply against a sink, and walking away
   * from it would leave the write half-done with the lease still held. Letting the tick
   * finish lets `drainLane` hand back whatever it never started.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.draining) await new Promise((r) => setTimeout(r, 10));
  }

  /** Drain every lane once. Exposed so a test or a shutdown can force a pass. */
  async drainOnce(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      let applied = 0;
      // Sequentially, not in parallel: the lanes share a connection pool, and draining
      // all six at once would starve the request path that shares it.
      for (const lane of Object.keys(this.registry) as IngestLane[]) {
        applied += await this.drainLane(lane);
      }
      await this.pruneIfDue();
      return applied;
    } finally {
      this.draining = false;
    }
  }

  /** Counters for a health endpoint. */
  stats(): { applied: number; failed: number } {
    return { applied: this.appliedCount, failed: this.failedCount };
  }

  private async drainLane(lane: IngestLane): Promise<number> {
    let claimed: QueuedBatch[];
    try {
      claimed = await this.store.claimPending(lane, this.opts.batchSize, this.opts.maxAttempts);
    } catch (err) {
      // A claim failure is the database being unreachable or the table being absent, not
      // a bad batch — there is nothing to park. Logged once per outage rather than per
      // tick; `tick` backs off so the condition is not hammered.
      if (this.claimFailures === 0) {
        this.log.error({ msg: "ingest_claim_failed", lane, err: errText(err) });
      }
      this.claimFailures += 1;
      return 0;
    }

    if (this.claimFailures > 0) {
      this.log.info({ msg: "ingest_claim_recovered", lane, after: this.claimFailures });
      this.claimFailures = 0;
    }

    let applied = 0;
    let i = 0;
    for (; i < claimed.length; i++) {
      if (this.stopped) break;
      if (await this.applyOne(claimed[i]!)) applied += 1;
    }

    // A claim is a written lease, so anything a shutdown skipped is still held by this
    // worker. Handing it back costs one statement and saves the batch — and everything
    // queued behind its partition key — from waiting out `CLAIM_LEASE_MS`.
    if (i < claimed.length) {
      const unprocessed = claimed.slice(i).map((b) => b.batchId);
      await this.store.releaseClaims(unprocessed).catch((err) => {
        this.log.warn({ msg: "ingest_release_claims_failed", n: unprocessed.length, err: errText(err) });
      });
    }
    return applied;
  }

  private async applyOne(batch: QueuedBatch): Promise<boolean> {
    try {
      // No separate completion write: `applyBatchOnce` inside the lane's own write flips
      // `completed_at` in the same transaction as the rows, which is what makes the apply
      // exactly-once rather than merely retried.
      await this.dispatch(batch);
      this.appliedCount += 1;
      this.log.debug({
        msg: "ingest_batch_applied",
        lane: batch.lane,
        rows: batch.rowCount,
      });
      return true;
    } catch (err) {
      this.failedCount += 1;
      const attempts = batch.attempts + 1;
      await this.store.markFailed(batch.batchId, errText(err)).catch((markErr) => {
        // If even recording the failure fails, the batch stays pending with its old
        // count and is retried. Worth a distinct log line: it means the database is in
        // worse shape than a single bad write.
        this.log.error({ msg: "ingest_mark_failed_failed", err: errText(markErr) });
      });

      const parked = attempts >= this.opts.maxAttempts;
      this.log[parked ? "error" : "warn"]({
        msg: parked ? "ingest_batch_parked" : "ingest_batch_retrying",
        lane: batch.lane,
        batch_id: batch.batchId,
        attempts,
        rows: batch.rowCount,
        err: errText(err),
      });
      return false;
    }
  }

  /**
   * Hand a batch to the lane that owns it.
   *
   * Rows are the lane's own input type, cast back from JSON. That coupling is why the
   * batch id is content-derived: a change to one of those shapes changes the hash, so an
   * old queued batch and a new one can never be confused for each other.
   */
  private async dispatch(batch: QueuedBatch): Promise<void> {
    const spec = this.registry[batch.lane];
    if (!spec) {
      // A lane that no longer exists — a feature removed while its batches were still
      // queued. Parking beats throwing on every tick forever.
      throw new Error(`no lane registered for '${batch.lane}'`);
    }
    await spec.apply(batch.batchId, batch.partitionKey, batch.payload.rows as never[]);
  }

  /** Prune applied rows on the same cadence as the outbox does, not every tick. */
  private async pruneIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneAt < this.opts.retainCompletedMs) return;
    this.lastPruneAt = now;
    try {
      const pruned = await this.store.pruneCompleted(new Date(now - this.opts.retainCompletedMs));
      if (pruned > 0) this.log.info({ msg: "ingest_batches_pruned", n: pruned });
    } catch (err) {
      this.log.warn({ msg: "ingest_prune_failed", err: errText(err) });
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const applied = await this.drainOnce();
    if (this.stopped) return;

    // No delay while there is work: a backlog drains as fast as the lanes allow. On a
    // claim outage, back off exponentially to a ceiling — the condition is external and
    // will not clear because we asked again sooner.
    if (this.claimFailures > 0) {
      const backoff = Math.min(
        this.opts.idleIntervalMs * 2 ** Math.min(this.claimFailures, 6),
        MAX_CLAIM_BACKOFF_MS,
      );
      this.schedule(backoff);
      return;
    }
    this.schedule(applied > 0 ? 0 : this.opts.idleIntervalMs);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
