import { beforeEach, describe, expect, it } from "bun:test";
import type { Logger } from "../../../platform/lib/logger";
import type { BatchQueue, IngestLane, LaneRegistry, LaneSpec, QueuedBatch } from "../interfaces";
import { CollectBuffer } from "../services/collect-buffer.service";

/**
 * The buffer's whole job is: accumulate, partition, and write one queue row per partition.
 *
 * Everything else it used to do — per-lane retry counters, two independent caps, four
 * different drop policies — moved to the durable queue, which does it properly. What is
 * left is worth testing precisely because it is the part that can still lose data: rows
 * live in memory until a flush lands them.
 */

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

type Enqueued = Parameters<BatchQueue["enqueue"]>[0];

class FakeQueue implements BatchQueue {
  written: Enqueued[] = [];
  /** Set to make `enqueue` reject, modelling an unreachable database. */
  failWith: Error | null = null;
  /** Fails only the first N calls, to exercise the retry path. */
  failTimes = 0;

  async enqueue(batch: Enqueued): Promise<void> {
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error("insert failed");
    }
    if (this.failWith) throw this.failWith;
    this.written.push(batch);
  }
  async claimPending(): Promise<QueuedBatch[]> { return []; }
  async markFailed(): Promise<void> {}
  async releaseClaims(): Promise<void> {}
  async countPending(): Promise<number> { return 0; }
  async countParked(): Promise<number> { return 0; }
  async pruneCompleted(): Promise<number> { return 0; }
}

/**
 * A lane that partitions by website and never writes anything itself.
 *
 * `threshold` reads the same config field production does, because the cap is derived
 * from it — a constant here would make the cap tests assert nothing.
 */
function lane(field: string, over: Partial<LaneSpec> = {}): LaneSpec {
  return {
    partitionOf: (_row, websiteId) => websiteId,
    apply: async () => 0,
    threshold: (cfg: { ingestQueue: Record<string, number> }) => cfg.ingestQueue[field]!,
    ...over,
  } as LaneSpec;
}

function registry(over: Partial<LaneRegistry> = {}): LaneRegistry {
  return {
    analytics: lane("maxEventsBeforeForceFlush"),
    funnels: lane("maxFunnelsBeforeForceFlush"),
    automations: lane("maxAutomationsBeforeForceFlush"),
    profiles: lane("maxProfilesBeforeForceFlush"),
    // The one lane whose key is load-bearing: chunk sequences are per session.
    recordings: lane("maxRecordingsBeforeForceFlush", {
      partitionOf: (row: { sid?: string }) => row.sid ?? "",
    }),
    // The one lane with a byte ceiling.
    heatmaps: lane("maxHeatmapsBeforeForceFlush", {
      maxBytes: () => 1_000,
      bytesOf: (rows: readonly { data?: { html?: string } }[]) =>
        rows.reduce((n, r) => n + (r.data?.html?.length ?? 0), 0),
    }),
    ...over,
  };
}

/** Config shape the buffer reads. Only the ingest thresholds matter here. */
function cfg(over: Record<string, number> = {}) {
  return {
    ingestQueue: {
      flushMs: 1000,
      maxEventsBeforeForceFlush: 10_000,
      maxFunnelsBeforeForceFlush: 10_000,
      maxRecordingsBeforeForceFlush: 10_000,
      maxHeatmapsBeforeForceFlush: 10_000,
      maxAutomationsBeforeForceFlush: 10_000,
      maxProfilesBeforeForceFlush: 10_000,
      maxHeatmapBytes: 1_000,
      ...over,
    },
  } as never;
}

const rows = (n: number, websiteId = "site_a") =>
  Array.from({ length: n }, (_, i) => ({ type: "pageview", ts: i, websiteId }));

describe("CollectBuffer", () => {
  let queue: FakeQueue;
  let buffer: CollectBuffer;

  beforeEach(() => {
    queue = new FakeQueue();
    buffer = new CollectBuffer(registry(), queue, silentLogger);
    buffer.configure(cfg());
  });

  describe("buffering", () => {
    it("writes nothing until a flush", () => {
      buffer.enqueue("analytics", "site_a", rows(3));
      expect(queue.written).toHaveLength(0);
      expect(buffer.depth().analytics).toBe(3);
    });

    it("turns a second of enqueues into one queue row", async () => {
      buffer.enqueue("analytics", "site_a", rows(2));
      buffer.enqueue("analytics", "site_a", rows(3));
      await buffer.flushNow();

      expect(queue.written).toHaveLength(1);
      expect(queue.written[0]!.rowCount).toBe(5);
      expect(buffer.depth().analytics).toBe(0);
    });

    it("ignores an empty batch", async () => {
      buffer.enqueue("analytics", "site_a", []);
      await buffer.flushNow();
      expect(queue.written).toHaveLength(0);
    });
  });

  describe("partitioning", () => {
    it("splits one lane's rows per website", async () => {
      buffer.enqueue("analytics", "site_a", rows(2));
      buffer.enqueue("analytics", "site_b", rows(1));
      await buffer.flushNow();

      expect(queue.written.map((b) => b.partitionKey).sort()).toEqual(["site_a", "site_b"]);
    });

    it("partitions recordings by session, not website", async () => {
      // Two sessions from one site must not share a batch: chunk sequences are assigned
      // per session, so applying them concurrently overwrites objects in storage.
      buffer.enqueue("recordings", "site_a", [
        { sid: "s1", ts: 1 },
        { sid: "s2", ts: 2 },
        { sid: "s1", ts: 3 },
      ]);
      await buffer.flushNow();

      expect(queue.written.map((b) => b.partitionKey).sort()).toEqual(["s1", "s2"]);
      expect(queue.written.find((b) => b.partitionKey === "s1")!.rowCount).toBe(2);
    });
  });

  describe("payload", () => {
    it("carries one shape for every lane, with the key in its own column", async () => {
      buffer.enqueue("automations", "site_a", [{ id: 1 }]);
      await buffer.flushNow();

      expect(JSON.parse(queue.written[0]!.payloadJson)).toEqual({ rows: [{ id: 1 }] });
      expect(queue.written[0]!.partitionKey).toBe("site_a");
      expect(queue.written[0]!.lane).toBe("automations");
    });

    it("derives the batch id from the rows, so a redelivery reuses it", async () => {
      buffer.enqueue("analytics", "site_a", rows(2));
      await buffer.flushNow();
      const first = queue.written[0]!.batchId;

      const second = new CollectBuffer(registry(), queue, silentLogger);
      second.configure(cfg());
      second.enqueue("analytics", "site_a", rows(2));
      await second.flushNow();

      expect(queue.written[1]!.batchId).toBe(first);
    });
  });

  describe("caps", () => {
    it("drops past the hard row cap rather than growing without bound", async () => {
      buffer.configure(cfg({ maxEventsBeforeForceFlush: 4 }));
      // Cap is 2x the force-flush threshold, so eight of the twenty are kept. The rest
      // are shed deliberately: an OOM kill loses every buffer at once, a drop loses one
      // batch and says so.
      buffer.enqueue("analytics", "site_a", rows(20));
      await buffer.flushNow();

      const kept = queue.written.reduce((n, b) => n + b.rowCount, 0);
      expect(kept).toBe(8);
    });

    it("drops a heatmap batch that would breach the byte ceiling", async () => {
      const big = [{ websiteId: "site_a", data: { html: "x".repeat(900) } }];
      buffer.enqueue("heatmaps", "site_a", big);
      buffer.enqueue("heatmaps", "site_a", big);
      await buffer.flushNow();

      // The second is refused: bytes, not rows, is what the container runs out of.
      expect(queue.written).toHaveLength(1);
    });

    it("forces a flush once a lane reaches its threshold", async () => {
      buffer.configure(cfg({ maxEventsBeforeForceFlush: 3 }));
      buffer.enqueue("analytics", "site_a", rows(3));
      await buffer.flushNow();

      expect(queue.written).toHaveLength(1);
    });
  });

  describe("a failed flush", () => {
    it("keeps the rows and lands them on the next attempt", async () => {
      queue.failTimes = 1;
      buffer.enqueue("analytics", "site_a", rows(2));
      await buffer.flushNow();
      expect(queue.written).toHaveLength(0);
      expect(buffer.depth().analytics).toBe(2);

      await buffer.flushNow();
      expect(queue.written).toHaveLength(1);
      expect(queue.written[0]!.rowCount).toBe(2);
    });

    it("gives up after three attempts rather than holding the buffer forever", async () => {
      queue.failWith = new Error("down");
      buffer.enqueue("analytics", "site_a", rows(2));

      await buffer.flushNow();
      await buffer.flushNow();
      await buffer.flushNow();

      expect(buffer.depth().analytics).toBe(0);
      expect(queue.written).toHaveLength(0);
    });

    it("retries every lane, not just analytics", async () => {
      // Recordings, heatmaps, automations and profiles used to log and vanish on the
      // first failure — an artifact of the old per-lane duplication, not a decision.
      queue.failTimes = 1;
      buffer.enqueue("heatmaps", "site_a", [{ websiteId: "site_a", data: {} }]);
      await buffer.flushNow();
      expect(queue.written).toHaveLength(0);

      await buffer.flushNow();
      expect(queue.written).toHaveLength(1);
      expect(queue.written[0]!.lane).toBe("heatmaps");
    });
  });

  describe("lifecycle", () => {
    it("stops the timer without draining, so shutdown must flush explicitly", async () => {
      buffer.start();
      buffer.enqueue("analytics", "site_a", rows(1));
      buffer.stop();
      expect(buffer.depth().analytics).toBe(1);

      await buffer.flushNow();
      expect(buffer.depth().analytics).toBe(0);
    });

    it("reports depth per lane", () => {
      buffer.enqueue("analytics", "site_a", rows(2));
      buffer.enqueue("profiles", "site_a", [{ websiteId: "site_a" }]);

      const depth = buffer.depth();
      expect(depth.analytics).toBe(2);
      expect(depth.profiles).toBe(1);
      expect(depth.heatmaps).toBe(0);
    });
  });
});
