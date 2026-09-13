import { beforeEach, describe, expect, it } from "bun:test";
import type { Logger } from "../../../platform/lib/logger";
import type { AutomationTriggerQueued, TrackerEvent } from "../../../platform/lib/types";
import type { HeatmapTrackerEvent } from "../../heatmaps/interfaces";
import type { VisitorProfileWrite } from "../../automations/interfaces";
import type {
  BatchQueue,
  IngestLane,
  LaneRegistry,
  LaneSpec,
  QueuedBatch,
} from "../interfaces";
import { BatchWorker } from "../services/batch-worker.service";

/**
 * The worker's job is claim → apply → complete, or claim → fail → park. No database here:
 * `BatchQueue` and `LaneRegistry` are both interfaces, which is why that logic is
 * testable at all.
 */

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

/**
 * In-memory queue, modelling `ingest_batches` including its lease.
 *
 * The lease is not incidental detail here: a claim in Postgres is a written `claimed_at`,
 * not a row lock, so a batch this worker claimed and did not apply stays held — and holds
 * its whole partition key behind it — until something gives it back. Modelling it is what
 * lets the shutdown path be tested at all.
 */
class FakeQueue implements BatchQueue {
  rows: (QueuedBatch & { completed: boolean; claimed: boolean; lastError?: string })[] = [];

  seed(batch: Partial<QueuedBatch> & { lane: IngestLane }): QueuedBatch {
    const row = {
      batchId: batch.batchId ?? `batch_${this.rows.length + 1}`,
      lane: batch.lane,
      partitionKey: batch.partitionKey ?? "site_a",
      payload: batch.payload ?? { rows: [] },
      rowCount: batch.rowCount ?? 1,
      attempts: batch.attempts ?? 0,
      completed: false,
      claimed: false,
    };
    this.rows.push(row);
    return row;
  }

  async enqueue(): Promise<void> {}

  /** Set to simulate an unreachable database or a missing table. */
  claimError: Error | null = null;
  /** How many times `claimPending` was called, to assert backoff behaviour. */
  claimCalls = 0;

  async claimPending(
    lane: IngestLane,
    limit: number,
    maxAttempts: number,
  ): Promise<QueuedBatch[]> {
    this.claimCalls += 1;
    if (this.claimError) throw this.claimError;
    // One batch per partition key, and never one already leased — the two properties
    // `claimPendingBatches` enforces in SQL.
    const takenKeys = new Set(
      this.rows.filter((r) => !r.completed && r.claimed).map((r) => r.partitionKey),
    );
    const out: QueuedBatch[] = [];
    for (const r of this.rows) {
      if (out.length >= limit) break;
      if (r.lane !== lane || r.completed || r.claimed) continue;
      if (r.attempts >= maxAttempts) continue;
      if (takenKeys.has(r.partitionKey)) continue;
      takenKeys.add(r.partitionKey);
      r.claimed = true;
      out.push(r);
    }
    return out;
  }

  async markCompleted(batchId: string): Promise<void> {
    const row = this.rows.find((r) => r.batchId === batchId);
    if (row) {
      row.completed = true;
      row.claimed = false;
    }
  }

  async markFailed(batchId: string, error: string): Promise<void> {
    const row = this.rows.find((r) => r.batchId === batchId);
    if (row) {
      row.attempts += 1;
      row.lastError = error;
      row.claimed = false;
    }
  }

  released: string[] = [];

  async releaseClaims(batchIds: string[]): Promise<void> {
    this.released.push(...batchIds);
    for (const id of batchIds) {
      const row = this.rows.find((r) => r.batchId === id);
      if (row) row.claimed = false;
    }
  }

  async countPending(lane: IngestLane, maxAttempts: number): Promise<number> {
    return this.rows.filter(
      (r) => r.lane === lane && !r.completed && r.attempts < maxAttempts,
    ).length;
  }

  async countParked(maxAttempts: number): Promise<number> {
    return this.rows.filter((r) => !r.completed && r.attempts >= maxAttempts).length;
  }

  async pruneCompleted(): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !r.completed);
    return before - this.rows.length;
  }
}

/**
 * Records what each lane received, and can be made to fail per lane.
 *
 * `apply` completes the batch on the way through, which is what `applyBatchOnce` does in
 * production: the completion flip happens inside the write's own transaction, not in a
 * separate call the worker makes afterwards.
 */
class FakeRegistry {
  analytics: { batchId: string; websiteId: string; count: number }[] = [];
  automations: unknown[][] = [];
  recordings: unknown[][] = [];
  heatmaps: unknown[][] = [];
  profiles: unknown[][] = [];

  failLanes = new Set<IngestLane>();
  /** Rows the analytics writer claims to have inserted; 0 models an already-applied batch. */
  insertedOverride: number | null = null;
  /** Runs before each analytics write, so a test can interrupt a drain mid-pass. */
  onAnalyticsWrite: (() => void) | null = null;

  constructor(private readonly queue: FakeQueue) {}

  private lane(name: IngestLane, record: (batchId: string, key: string, rows: never[]) => number | void): LaneSpec {
    return {
      partitionOf: (_row, websiteId) => websiteId,
      threshold: () => 50_000,
      apply: async (batchId, partitionKey, rows) => {
        const out = record(batchId, partitionKey, rows);
        if (this.failLanes.has(name)) throw new Error(`${name} write failed`);
        await this.queue.markCompleted(batchId);
        return out ?? undefined;
      },
    };
  }

  build(): LaneRegistry {
    return {
      analytics: this.lane("analytics", (batchId, websiteId, rows) => {
        this.onAnalyticsWrite?.();
        this.analytics.push({ batchId, websiteId, count: rows.length });
        return this.insertedOverride ?? rows.length;
      }),
      funnels: this.lane("funnels", (batchId, websiteId, rows) => {
        this.onAnalyticsWrite?.();
        this.analytics.push({ batchId, websiteId, count: rows.length });
        return this.insertedOverride ?? rows.length;
      }),
      automations: this.lane("automations", (_id, _key, rows) => void this.automations.push([...rows])),
      recordings: this.lane("recordings", (_id, _key, rows) => void this.recordings.push([...rows])),
      heatmaps: this.lane("heatmaps", (_id, _key, rows) => void this.heatmaps.push([...rows])),
      profiles: this.lane("profiles", (_id, _key, rows) => void this.profiles.push([...rows])),
    };
  }
}

/** Raw tracker events — what the queue carries now that analytics owns the projection. */
function events(n: number): TrackerEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "pageview",
    ts: 1_767_225_600_000 + i,
    sid: `sess_${i}`,
    websiteId: "site_a",
  }));
}

describe("BatchWorker", () => {
  let queue: FakeQueue;
  let sinks: FakeRegistry;
  let worker: BatchWorker;

  beforeEach(() => {
    queue = new FakeQueue();
    sinks = new FakeRegistry(queue);
    worker = new BatchWorker(queue, sinks.build(), silentLogger, { maxAttempts: 3 });
  });

  describe("dispatch", () => {
    it("routes an analytics batch to the analytics writer", async () => {
      queue.seed({
        lane: "analytics",
        batchId: "b1",
        payload: { rows: events(3) },
        rowCount: 3,
      });

      await worker.drainOnce();

      expect(sinks.analytics).toEqual([{ batchId: "b1", websiteId: "site_a", count: 3 }]);
    });

    // Funnels share the analytics table and writer; only the queue category differs.
    it("routes a funnels batch to the same writer", async () => {
      queue.seed({
        lane: "funnels",
        payload: { rows: events(2) },
        rowCount: 2,
      });

      await worker.drainOnce();

      expect(sinks.analytics).toHaveLength(1);
    });

    it("routes each other category to its own sink", async () => {
      queue.seed({ lane: "automations", payload: { rows: [{ a: 1 }] } });
      queue.seed({ lane: "recordings", payload: { rows: [{ sid: "s1" }] } });
      queue.seed({ lane: "heatmaps", payload: { rows: [{ type: "heatmap_click" }] } });

      await worker.drainOnce();

      expect(sinks.automations).toHaveLength(1);
      expect(sinks.recordings).toHaveLength(1);
      expect(sinks.heatmaps).toHaveLength(1);
    });

    /**
     * The batch id must reach the sink, or the idempotency marker has nothing to key on
     * and every redelivery writes again.
     */
    it("passes the batch id through to the sink", async () => {
      queue.seed({
        lane: "analytics",
        batchId: "stable_id",
        payload: { rows: events(1) },
      });

      await worker.drainOnce();

      expect(sinks.analytics[0]?.batchId).toBe("stable_id");
    });
  });

  describe("completion", () => {
    it("marks an applied batch completed so it is not claimed again", async () => {
      queue.seed({ lane: "analytics", payload: { rows: events(1) } });

      await worker.drainOnce();
      await worker.drainOnce();

      expect(sinks.analytics).toHaveLength(1);
      expect(await queue.countPending("analytics", 3)).toBe(0);
    });

    it("reports how many batches it applied", async () => {
      queue.seed({ lane: "analytics", payload: { rows: events(1) } });
      queue.seed({ lane: "heatmaps", payload: { rows: [] } });

      expect(await worker.drainOnce()).toBe(2);
    });
  });

  describe("failure handling", () => {
    it("leaves a failed batch pending and counts the attempt", async () => {
      sinks.failLanes.add("analytics");
      queue.seed({
        lane: "analytics",
        batchId: "b1",
        payload: { rows: events(1) },
      });

      await worker.drainOnce();

      const row = queue.rows.find((r) => r.batchId === "b1");
      expect(row?.completed).toBe(false);
      expect(row?.attempts).toBe(1);
      expect(row?.lastError).toContain("analytics write failed");
    });

    it("retries on the next pass and completes once the sink recovers", async () => {
      sinks.failLanes.add("analytics");
      queue.seed({ lane: "analytics", payload: { rows: events(1) } });

      await worker.drainOnce();
      sinks.failLanes.clear();
      await worker.drainOnce();

      expect(sinks.analytics).toHaveLength(2);
      expect(await queue.countPending("analytics", 3)).toBe(0);
    });

    /**
     * Parked, never dropped — the difference from the in-memory flush, which discards a
     * batch after three attempts with only a log line. A durable row can be inspected and
     * replayed by resetting its attempt count.
     */
    it("parks a batch that exhausts its attempts instead of dropping it", async () => {
      sinks.failLanes.add("analytics");
      queue.seed({ lane: "analytics", payload: { rows: events(1) } });

      await worker.drainOnce();
      await worker.drainOnce();
      await worker.drainOnce();
      const attemptsBefore = sinks.analytics.length;
      await worker.drainOnce();

      // No longer claimed, but still present and still incomplete.
      expect(sinks.analytics).toHaveLength(attemptsBefore);
      expect(await queue.countParked(3)).toBe(1);
      expect(queue.rows).toHaveLength(1);
    });

    /**
     * Category isolation, which is the reason each is polled separately. A stalled heatmap
     * consumer used to delay analytics writes for every site through the shared flush.
     */
    it("keeps other categories draining while one fails", async () => {
      sinks.failLanes.add("heatmaps");
      queue.seed({ lane: "heatmaps", payload: { rows: [] } });
      queue.seed({ lane: "analytics", payload: { rows: events(1) } });

      await worker.drainOnce();

      expect(sinks.analytics).toHaveLength(1);
      expect(await queue.countPending("analytics", 3)).toBe(0);
      expect(await queue.countPending("heatmaps", 3)).toBe(1);
    });
  });

  describe("applying analytics batches", () => {
    it("hands the sink the rows and completes the batch", async () => {
      queue.seed({
        lane: "analytics",
        payload: { rows: events(3) },
        rowCount: 3,
      });

      await worker.drainOnce();

      expect(sinks.analytics).toEqual([{ batchId: "batch_1", websiteId: "site_a", count: 3 }]);
      expect(await queue.countPending("analytics", 3)).toBe(0);
    });

    it("takes one batch per site in a pass", async () => {
      // Distinct partition keys, as `flushAnalytics` assigns them — a site's batches are
      // keyed on its own id, so two sites are never serialised against each other.
      queue.seed({
        lane: "analytics",
        partitionKey: "site_a",
        payload: { rows: events(1) },
      });
      queue.seed({
        lane: "analytics",
        partitionKey: "site_b",
        payload: { rows: events(1) },
      });

      await worker.drainOnce();

      expect(sinks.analytics.map((a) => a.websiteId).sort()).toEqual(["site_a", "site_b"]);
    });
  });

  /**
   * A claim is a written lease, not a lock — see `claimPendingBatches`. Both properties
   * that depend on that are worth pinning here, because both were silently false while the
   * claim was a `FOR UPDATE` released at statement end.
   */
  describe("claims", () => {
    it("takes at most one batch per partition key", async () => {
      // Two batches for one replay session. Applying them together assigns both the same
      // chunk sequence, and the second overwrites the first in object storage.
      queue.seed({ lane: "recordings", partitionKey: "sess_1", payload: { rows: events(1) } });
      queue.seed({ lane: "recordings", partitionKey: "sess_1", payload: { rows: events(1) } });

      await worker.drainOnce();

      expect(sinks.recordings).toHaveLength(1);
    });

    it("takes batches for different partition keys in the same pass", async () => {
      queue.seed({ lane: "recordings", partitionKey: "sess_1", payload: { rows: events(1) } });
      queue.seed({ lane: "recordings", partitionKey: "sess_2", payload: { rows: events(1) } });

      await worker.drainOnce();

      expect(sinks.recordings).toHaveLength(2);
    });

    it("hands back claims a shutdown did not get to", async () => {
      queue.seed({
        lane: "analytics",
        batchId: "first",
        partitionKey: "site_a",
        payload: { rows: events(1) },
      });
      queue.seed({
        lane: "analytics",
        batchId: "second",
        partitionKey: "site_b",
        payload: { rows: events(1) },
      });

      // Not awaited: `stop` waits for the drain it is interrupting, so awaiting it from
      // inside that drain would deadlock. It flips the flag synchronously, which is all
      // this needs.
      sinks.onAnalyticsWrite = () => {
        sinks.onAnalyticsWrite = null;
        void worker.stop();
      };

      await worker.drainOnce();

      // The second batch was claimed and never applied. Left leased it would sit out
      // `CLAIM_LEASE_MS`, and every later batch for its key behind it.
      expect(sinks.analytics).toHaveLength(1);
      expect(queue.released).toEqual(["second"]);
      expect(queue.rows.find((r) => r.batchId === "second")!.claimed).toBe(false);
    });

    it("releases nothing when the pass ran to the end", async () => {
      queue.seed({
        lane: "analytics",
        partitionKey: "site_a",
        payload: { rows: events(1) },
      });

      await worker.drainOnce();

      expect(queue.released).toEqual([]);
    });
  });

  describe("lifecycle", () => {
    it("drains nothing on an empty queue", async () => {
      expect(await worker.drainOnce()).toBe(0);
      expect(sinks.analytics).toEqual([]);
    });

    it("stops cleanly without a pass in flight", async () => {
      worker.start();
      await worker.stop();
      expect(worker.stats().failed).toBe(0);
    });
  });

  /**
   * Regression: the worker logged this error roughly twenty times a second — once per
   * category per tick — when `ingest_batches` was missing, burying every other line in
   * the log. A claim failure is an external condition that persists, so it is reported
   * once and then backed off.
   */
  describe("claim failure", () => {
    it("does not treat a claim failure as an applied batch", async () => {
      queue.claimError = new Error('relation "ingest_batches" does not exist');
      queue.seed({ lane: "analytics", payload: { rows: events(1) } });

      expect(await worker.drainOnce()).toBe(0);
      expect(sinks.analytics).toEqual([]);
    });

    it("logs the failure once rather than on every pass", async () => {
      const lines: Record<string, unknown>[] = [];
      const capturing: Logger = {
        debug() {},
        info() {},
        warn() {},
        error(fields) {
          lines.push(fields as Record<string, unknown>);
        },
        child() {
          return capturing;
        },
      };
      const noisy = new BatchWorker(queue, sinks.build(), capturing, { maxAttempts: 3 });
      queue.claimError = new Error("connection refused");

      await noisy.drainOnce();
      await noisy.drainOnce();
      await noisy.drainOnce();

      expect(lines.filter((l) => l.msg === "ingest_claim_failed")).toHaveLength(1);
    });

    it("leaves the batch pending, with no attempt charged against it", async () => {
      queue.claimError = new Error("connection refused");
      const seeded = queue.seed({
        lane: "analytics",
        payload: { rows: events(1) },
      });

      await worker.drainOnce();

      const row = queue.rows.find((r) => r.batchId === seeded.batchId);
      expect(row?.attempts).toBe(0);
      expect(row?.completed).toBe(false);
    });

    it("resumes once the database comes back", async () => {
      queue.claimError = new Error("connection refused");
      queue.seed({ lane: "analytics", payload: { rows: events(1) } });

      await worker.drainOnce();
      queue.claimError = null;
      await worker.drainOnce();

      expect(sinks.analytics).toHaveLength(1);
    });
  });
});
