import type { AppConfig } from "../../../config";

/**
 * The ingest module's public surface.
 *
 * Ingest is the write half of the product: the tracker posts a mixed batch to `/collect`,
 * ingest splits it by lane, buffers each lane, and a worker applies the batches. What it
 * does *not* do is know what any of that data means — every lane declares its own
 * partitioning, its own back-pressure and its own write, and the module that owns the data
 * owns that declaration. See `LaneSpec`.
 */

/**
 * The six lanes a batch can travel in.
 *
 * Lanes, not modules: `analytics` and `funnels` both end up in the analytics writer, and
 * `profiles` belongs to the automations module. They are split so one lane's backlog
 * cannot stall another's — heatmaps is by far the slowest consumer, and in a single-queue
 * design its latency delayed every site's pageview writes.
 */
export type IngestLane =
  | "analytics"
  | "funnels"
  | "automations"
  | "recordings"
  | "heatmaps"
  | "profiles";

/**
 * One feature's ingest, declared by the module that owns the data.
 *
 * This is the seam that keeps ingest ignorant of analytics, recordings, heatmaps and
 * automations. It replaced a five-method `IngestTargets` interface plus a `switch` in the
 * worker, which meant adding a feature touched five files in three modules; a lane is now
 * one file, and removing one is deleting it.
 */
export type LaneSpec = {
  /**
   * Which partition a row belongs to. Work is serialised within a key, so this is an
   * ordering decision: recordings partition by session because chunk sequences are
   * assigned per session, everything else by website so one busy site cannot monopolise
   * a lane.
   */
  partitionOf(row: never, websiteId: string): string;

  /**
   * Apply one claimed batch.
   *
   * Must be idempotent on `batchId` — the worker retries, and two of the six writes
   * accumulate (`intensity + EXCLUDED.intensity`, `visit_count + …`) rather than insert,
   * so a repeat would corrupt a number rather than duplicate a row. `applyBatchOnce` is
   * how every lane gets that.
   *
   * Returns rows written, where the lane can say; `void` where the count is meaningless
   * (object-storage writes).
   */
  apply(batchId: string, partitionKey: string, rows: never[]): Promise<number | void>;

  /** Buffered rows in this lane before a flush is forced, ahead of the interval. */
  threshold(cfg: AppConfig): number;

  /**
   * Byte ceiling for this lane's buffer, when a row count is a bad proxy for memory.
   *
   * Only heatmaps needs one: a click is tens of bytes, a screenshot is megabytes, so a
   * count-based cap was anything between two megabytes and eighty gigabytes in a
   * container capped at 896MB.
   */
  maxBytes?(cfg: AppConfig): number;

  /** Approximate retained bytes, paired with `maxBytes`. Kept cheap — it runs per enqueue. */
  bytesOf?(rows: readonly never[]): number;
};

/** Every lane, by name. Assembled at composition time from the owning modules. */
export type LaneRegistry = Record<IngestLane, LaneSpec>;

/**
 * Buffering for the `/collect` path.
 *
 * Enqueues are synchronous and deliberately cheap: the HTTP handler must return without
 * waiting on a database or object storage, so the request pays for a push and nothing
 * more. Durability is traded away for that — see `IngestFlusher`.
 */
export interface IngestQueue {
  /**
   * Buffer rows for one lane.
   *
   * `websiteId` is the request's site; the lane decides whether that is the partition key
   * or whether it derives one per row. Rows are raw — the buffer becomes a durable queue
   * row, so whatever shape it holds is a stored contract, and each lane projects at apply
   * time.
   */
  enqueue(lane: IngestLane, websiteId: string, rows: readonly unknown[]): void;
}

/**
 * Lifecycle for the background flush.
 *
 * **The durability trade-off is here.** Buffers live in memory, so anything not yet
 * flushed is lost if the process dies — which is why `flushNow` exists and why shutdown
 * must await it. Everything past the flush is durable: a batch is a committed row before
 * any module write is attempted.
 */
export interface IngestFlusher {
  /** Start the interval timer. Idempotent. */
  start(): void;

  /** Stop the timer. Does not drain — call `flushNow` for that. */
  stop(): void;

  /** Drain every buffer onto the queue. Call before process exit. */
  flushNow(): Promise<void>;

  /** Buffered rows per lane, for health checks and diagnostics. */
  depth(): Record<IngestLane, number>;
}

/** A batch as it comes back off the durable queue. */
export type QueuedBatch = {
  batchId: string;
  lane: IngestLane;
  /** Session id for recordings, website id otherwise — see `ingest_batches`. */
  partitionKey: string;
  payload: { rows: unknown[] };
  rowCount: number;
  /** Failed attempts so far. At the cap the batch is parked rather than dropped. */
  attempts: number;
};

/**
 * The durable queue, as producer and worker see it.
 *
 * An interface so the worker's claim/apply/park logic — the part actually worth testing —
 * can run against an in-memory double. `postgresBatchQueue` is the production
 * implementation, kept in a separate file so importing the worker does not require a
 * database connection.
 */
export interface BatchQueue {
  /**
   * `payloadJson` is pre-serialized, not an object.
   *
   * The producer has already serialized these rows to derive the batch id, and handing
   * over an object would make the driver serialize them a second time — a full extra pass
   * over a payload that can be megabytes, on one thread. See `serializeBatch`.
   */
  enqueue(batch: {
    batchId: string;
    lane: IngestLane;
    partitionKey: string;
    payloadJson: string;
    rowCount: number;
  }): Promise<void>;

  claimPending(lane: IngestLane, limit: number, maxAttempts: number): Promise<QueuedBatch[]>;

  markFailed(batchId: string, error: string): Promise<void>;

  /**
   * Hand back batches that were claimed but never applied, without counting an attempt.
   *
   * A claim is a written lease, so a worker that stops mid-drain would otherwise strand
   * every batch it had claimed — and, because at most one batch per partition key is in
   * flight, everything queued behind those keys with them — until the lease expired.
   */
  releaseClaims(batchIds: string[]): Promise<void>;

  countPending(lane: IngestLane, maxAttempts: number): Promise<number>;
  countParked(maxAttempts: number): Promise<number>;
  pruneCompleted(olderThan: Date): Promise<number>;
}
