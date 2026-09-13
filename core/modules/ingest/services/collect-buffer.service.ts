import { serializeBatch } from "../../../platform/idempotency/batch-id";
import type { AppConfig } from "../../../config";
import { log as baseLog } from "../../../platform/lib/logger";
import type { Logger } from "../../../platform/lib/logger";
import type {
  BatchQueue,
  IngestFlusher,
  IngestLane,
  IngestQueue,
  LaneRegistry,
  LaneSpec,
} from "../interfaces";

/** Flush attempts for one partition before its rows are dropped with a logged count. */
const MAX_FLUSH_ATTEMPTS = 3;

/**
 * Hard per-lane row cap, as a multiple of the force-flush threshold.
 *
 * Enqueues past it are dropped and counted, so a stalled flush cannot grow the buffers
 * until the process runs out of memory. Shedding load is recoverable; an OOM kill loses
 * every buffer at once.
 */
const HARD_CAP_MULTIPLIER = 2;



/**
 * The gap between `/collect` returning and a batch reaching the durable queue.
 *
 * Everything here exists to turn many small HTTP requests into few queue rows: a second's
 * worth of events becomes one insert instead of one per request. The handler pays for a
 * push and nothing else, which is what keeps `/collect` fast however much downstream work
 * the batch eventually causes.
 *
 * **This is not the queue.** `BatchQueue` is — a Postgres table, drained by `BatchWorker`,
 * where retries and parking live. The distinction matters because it bounds what can be
 * lost: rows sitting here when the process dies are gone, and rows that reached the queue
 * are not. That is also why this file is deliberately thin. It used to carry its own
 * retry counters, requeue paths and two independent caps, duplicating machinery the
 * durable queue already does properly — and every one of those paths was another way to
 * drop data silently.
 *
 * Rows are partitioned on arrival, not at flush time: recordings partition by session
 * because chunk sequences are assigned per session, everything else by website so one busy
 * site cannot monopolise a lane.
 */
export class CollectBuffer implements IngestQueue, IngestFlusher {
  private readonly log: Logger;
  private readonly lanes: IngestLane[];

  /** lane → partition key → rows awaiting a flush. */
  private buffers = new Map<IngestLane, Map<string, unknown[]>>();

  /** Row counts per lane, maintained incrementally — the alternative is a walk per enqueue. */
  private counts: Record<IngestLane, number>;

  /** Approximate retained bytes per lane, for the lanes that declare a `maxBytes`. */
  private bytes: Record<IngestLane, number>;

  /** Consecutive failed flushes, keyed `lane\0partition`. */
  private readonly attempts = new Map<string, number>();

  private thresholds: Record<IngestLane, number>;
  private maxBytes: Partial<Record<IngestLane, number>> = {};
  private flushMs = 1000;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Serializes every drain, whether from the timer or a threshold.
   *
   * Without it a threshold flush can interleave with the timer's, and the second takes an
   * empty snapshot while the first still holds the rows — which reads as a successful
   * no-op and leaves data in memory.
   */
  private flushChain: Promise<void> = Promise.resolve();
  private pendingFlush: Promise<void> | null = null;

  constructor(
    private readonly registry: LaneRegistry,
    private readonly queue: BatchQueue,
    logger: Logger = baseLog,
  ) {
    this.log = logger.child({ category: "ingest" });
    this.lanes = Object.keys(registry) as IngestLane[];
    this.counts = this.zeroed();
    this.bytes = this.zeroed();
    // Until `configure` runs. Any flush before then is interval-driven, which is correct
    // — a threshold is an optimisation, not a correctness boundary.
    this.thresholds = this.zeroed();
    for (const lane of this.lanes) this.thresholds[lane] = Number.POSITIVE_INFINITY;
  }

  private zeroed(): Record<IngestLane, number> {
    return Object.fromEntries(this.lanes.map((l) => [l, 0])) as Record<IngestLane, number>;
  }

  configure(cfg: AppConfig): void {
    this.flushMs = cfg.ingestQueue.flushMs;
    for (const lane of this.lanes) {
      const spec = this.registry[lane];
      this.thresholds[lane] = spec.threshold(cfg);
      const cap = spec.maxBytes?.(cfg);
      if (cap != null) this.maxBytes[lane] = cap;
    }
  }

  // ── IngestFlusher ─────────────────────────────────────────────────────────

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => void this.scheduleFlush(), this.flushMs);
  }

  stop(): void {
    if (!this.flushTimer) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  async flushNow(): Promise<void> {
    await this.scheduleFlush();
  }

  depth(): Record<IngestLane, number> {
    return { ...this.counts };
  }

  // ── IngestQueue ───────────────────────────────────────────────────────────

  enqueue(lane: IngestLane, websiteId: string, rows: readonly unknown[]): void {
    if (!rows.length) return;
    const spec = this.registry[lane];

    // Bytes before rows, where a lane declares a ceiling: one screenshot is worth ten
    // thousand clicks, and a row count cannot see the difference.
    const cap = this.maxBytes[lane];
    if (cap != null && spec.bytesOf) {
      const incoming = spec.bytesOf(rows as never[]);
      if (this.bytes[lane] + incoming > cap) {
        this.log.warn({
          msg: "ingest_byte_cap_drop",
          lane,
          dropped: rows.length,
          queued_bytes: this.bytes[lane],
          cap_bytes: cap,
        });
        void this.scheduleFlush();
        return;
      }
    }

    for (const [partitionKey, group] of groupBy(rows, (row) =>
      spec.partitionOf(row as never, websiteId),
    )) {
      this.buffer(lane, spec, partitionKey, group);
    }
  }

  /** Buffer one partition's rows, trimming to the hard cap. */
  private buffer(lane: IngestLane, spec: LaneSpec, partitionKey: string, rows: unknown[]): void {
    const cap = this.thresholds[lane] * HARD_CAP_MULTIPLIER;
    const room = cap - this.counts[lane];
    const accepted = room >= rows.length ? rows : rows.slice(0, Math.max(0, room));
    if (accepted.length < rows.length) {
      this.log.warn({
        msg: "ingest_queue_full_drop",
        lane,
        dropped: rows.length - accepted.length,
        queued: this.counts[lane],
        cap,
      });
    }
    if (!accepted.length) return;

    const byPartition = this.buffers.get(lane) ?? new Map<string, unknown[]>();
    const current = byPartition.get(partitionKey);
    if (current) pushAll(current, accepted);
    else byPartition.set(partitionKey, [...accepted]);
    this.buffers.set(lane, byPartition);

    this.counts[lane] += accepted.length;
    if (spec.bytesOf) this.bytes[lane] += spec.bytesOf(accepted as never[]);

    if (this.counts[lane] >= this.thresholds[lane]) void this.scheduleFlush();
  }

  // ── Flush ─────────────────────────────────────────────────────────────────

  private scheduleFlush(): Promise<void> {
    // One flush queued behind the running one is enough: it has not started, so it will
    // see everything a later caller would have wanted flushed.
    if (this.pendingFlush) return this.pendingFlush;

    const run = this.flushChain.then(() => {
      this.pendingFlush = null;
      return this.executeFlush();
    });
    // The chain must never hold a rejected promise, or every later flush inherits the
    // rejection and stops running.
    this.flushChain = run.catch((err: unknown) => {
      this.log.error({ msg: "ingest_flush_failed", error: errText(err) });
    });
    this.pendingFlush = this.flushChain;
    return run;
  }

  private async executeFlush(): Promise<void> {
    const snapshot = this.buffers;
    this.buffers = new Map();
    this.counts = this.zeroed();
    this.bytes = this.zeroed();

    const writes: Promise<void>[] = [];
    for (const [lane, byPartition] of snapshot) {
      for (const [partitionKey, rows] of byPartition) {
        if (rows.length) writes.push(this.queueBatch(lane, partitionKey, rows));
      }
    }
    // Independent by construction — one partition failing must not hold up the rest.
    await Promise.all(writes);
  }

  /**
   * Put one partition's rows on the durable queue.
   *
   * Enqueue is idempotent on the content-derived id, so a write that lands and then fails
   * before returning does not queue the batch twice.
   */
  private async queueBatch(lane: IngestLane, partitionKey: string, rows: unknown[]): Promise<void> {
    const { json, batchId } = serializeBatch(rows);
    try {
      await this.queue.enqueue({
        batchId,
        lane,
        partitionKey,
        // One payload shape for every lane. The partition key is already its own column,
        // so nothing here needs to repeat it.
        payloadJson: `{"rows":${json}}`,
        rowCount: rows.length,
      });
      this.attempts.delete(attemptKey(lane, partitionKey));
      this.log.debug({ msg: "ingest_batch_queued", lane, partition: partitionKey, rows: rows.length });
    } catch (err) {
      this.requeue(lane, partitionKey, rows, err);
    }
  }

  /**
   * Put a failed batch back at the front of its partition and retry next flush, up to
   * `MAX_FLUSH_ATTEMPTS`, then drop it with a logged count.
   *
   * Uniform across lanes, deliberately. Previously only analytics and funnels retried;
   * recordings, heatmaps, automations and profiles logged and vanished. Nothing about
   * those lanes makes their loss more acceptable — the asymmetry was an artifact of the
   * old per-lane duplication.
   */
  private requeue(lane: IngestLane, partitionKey: string, rows: unknown[], err: unknown): void {
    const key = attemptKey(lane, partitionKey);
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    const error = errText(err);

    if (attempt >= MAX_FLUSH_ATTEMPTS) {
      this.attempts.delete(key);
      this.log.error({
        msg: "ingest_batch_dropped",
        lane,
        partition: partitionKey,
        attempts: attempt,
        dropped: rows.length,
        error,
      });
      return;
    }

    this.attempts.set(key, attempt);
    const byPartition = this.buffers.get(lane) ?? new Map<string, unknown[]>();
    const current = byPartition.get(partitionKey);
    // Prepended so ordering survives the retry.
    byPartition.set(partitionKey, current?.length ? [...rows, ...current] : rows);
    this.buffers.set(lane, byPartition);
    this.counts[lane] += rows.length;
    this.bytes[lane] += this.registry[lane].bytesOf?.(rows as never[]) ?? 0;

    this.log.error({
      msg: "ingest_batch_requeued",
      lane,
      partition: partitionKey,
      attempt,
      requeued: rows.length,
      error,
    });
  }
}

function attemptKey(lane: IngestLane, partitionKey: string): string {
  return `${lane}\0${partitionKey}`;
}

/**
 * Append `src` to `target` in place.
 *
 * `push.apply` rather than spread: a `/collect` call can carry tens of thousands of
 * events, and `push(...src)` puts every one on the argument stack and overflows it.
 */
function pushAll<T>(target: T[], src: readonly T[]): void {
  Array.prototype.push.apply(target, src as T[]);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Group rows by key, preserving arrival order within each group. */
function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): [string, T[]][] {
  const byKey = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }
  return [...byKey];
}
