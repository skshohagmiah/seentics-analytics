import { describe, it, expect, beforeEach } from "bun:test";
// Registers the shared infrastructure stubs. Must come before the module under test.
import { warnings, resetStubs } from "./support/stubs";

const { SessionChunkBuffer } = await import("../services/session-chunk-buffer");

type Flush = { websiteId: string; sessionId: string; sequence: number; count: number };

function makeSpool() {
  const flushes: Flush[] = [];
  const spool = new SessionChunkBuffer({
    // Floored to 5s internally; long enough that no timer fires during a test.
    chunkFlushMs: 60_000,
    getInitialSequence: async () => 0,
    onChunkFlush: async (websiteId, sessionId, sequence, events) => {
      flushes.push({ websiteId, sessionId, sequence, count: events.length });
    },
  });
  return { spool, flushes };
}

/** An envelope of roughly `bytes` serialized size. */
function envelope(bytes: number, ts = 1): Record<string, unknown> {
  return { type: "rrweb", ts, data: { timestamp: ts, blob: "x".repeat(Math.max(1, bytes)) } };
}

describe("SessionChunkBuffer", () => {
  beforeEach(() => {
    resetStubs();
  });

  describe("buffering", () => {
    it("accepts events and holds them until flushed", async () => {
      const { spool, flushes } = makeSpool();
      spool.push("w1", "s1", [envelope(10), envelope(10)]);

      expect(flushes).toEqual([]);
      await spool.flushAll();
      expect(flushes).toEqual([{ websiteId: "w1", sessionId: "s1", sequence: 0, count: 2 }]);
    });

    it("keeps sessions separate", async () => {
      const { spool, flushes } = makeSpool();
      spool.push("w1", "s1", [envelope(10)]);
      spool.push("w1", "s2", [envelope(10), envelope(10)]);

      await spool.flushAll();
      await spool.flushAll();

      expect(flushes.map((f) => [f.sessionId, f.count])).toEqual([
        ["s1", 1],
        ["s2", 2],
      ]);
    });

    it("is a no-op for a session with nothing buffered", async () => {
      const { spool, flushes } = makeSpool();
      await spool.flushAll();
      expect(flushes).toEqual([]);
    });

    it("empties the buffer, so a second flush writes nothing", async () => {
      const { spool, flushes } = makeSpool();
      spool.push("w1", "s1", [envelope(10)]);

      await spool.flushAll();
      await spool.flushAll();

      expect(flushes).toHaveLength(1);
    });
  });

  /**
   * The byte budget is the guard that matters for process stability. The event count
   * alone is a poor proxy: rrweb envelopes run from tens of bytes for a mouse move to
   * hundreds of kilobytes for a canvas frame, so a count-only cap could admit
   * gigabytes from one canvas-heavy session.
   */
  describe("byte budget", () => {
    it("admits events well under the budget", () => {
      const { spool } = makeSpool();
      spool.push("w1", "s1", [envelope(1024)]);

      expect(warnings.filter((w) => w.msg === "replay_spool_byte_overflow_drop")).toEqual([]);
    });

    it("drops further events once the budget is exceeded", async () => {
      const { spool, flushes } = makeSpool();

      // 32MB budget; 40 x 1MB envelopes crosses it.
      for (let i = 0; i < 40; i++) spool.push("w1", "s1", [envelope(1_000_000, i)]);

      const dropped = warnings.filter((w) => w.msg === "replay_spool_byte_overflow_drop");
      expect(dropped.length).toBeGreaterThan(0);

      // What was admitted before the budget ran out is still flushed — the cap sheds
      // the tail, it does not discard the recording.
      await spool.flushAll();
      expect(flushes[0]!.count).toBeGreaterThan(0);
      expect(flushes[0]!.count).toBeLessThan(40);
    });

    it("reports the session and the size in the drop warning", () => {
      const { spool } = makeSpool();
      for (let i = 0; i < 40; i++) spool.push("w1", "sBig", [envelope(1_000_000, i)]);

      const dropped = warnings.find((w) => w.msg === "replay_spool_byte_overflow_drop");
      expect(dropped).toMatchObject({ session_id: "sBig" });
      expect(dropped?.approx_bytes).toBeGreaterThan(0);
    });

    // The counter tracks the live buffer, not the session's lifetime total, so a
    // long recording that keeps flushing is never throttled.
    it("frees the budget again after a flush", async () => {
      const { spool } = makeSpool();
      for (let i = 0; i < 40; i++) spool.push("w1", "s1", [envelope(1_000_000, i)]);
      await spool.flushAll();

      warnings.length = 0;
      spool.push("w1", "s1", [envelope(1024)]);

      expect(warnings.filter((w) => w.msg === "replay_spool_byte_overflow_drop")).toEqual([]);
    });

    it("budgets each session independently", () => {
      const { spool } = makeSpool();
      for (let i = 0; i < 40; i++) spool.push("w1", "big", [envelope(1_000_000, i)]);

      warnings.length = 0;
      spool.push("w1", "small", [envelope(1024)]);

      expect(warnings.filter((w) => w.msg === "replay_spool_byte_overflow_drop")).toEqual([]);
    });

    // An envelope that cannot be serialized still has to be charged for, or a
    // circular payload would be a free pass past the budget.
    it("charges a nominal cost for an unserializable envelope", () => {
      const { spool } = makeSpool();
      const circular: Record<string, unknown> = { type: "rrweb", ts: 1 };
      circular.self = circular;

      expect(() => spool.push("w1", "s1", [circular])).not.toThrow();
    });
  });

  describe("warm tail", () => {
    it("exposes unflushed events for the player", () => {
      const { spool } = makeSpool();
      spool.push("w1", "s1", [envelope(10, 5)]);

      const warm = spool.warmChunks("w1", "s1");
      expect(warm).not.toBeNull();
    });

    it("returns null for an unknown session", () => {
      const { spool } = makeSpool();
      expect(spool.warmChunks("w1", "nope")).toBeNull();
    });

    it("returns null once the tail has been flushed away", async () => {
      const { spool } = makeSpool();
      spool.push("w1", "s1", [envelope(10, 5)]);
      await spool.flushAll();

      expect(spool.warmChunks("w1", "s1")).toBeNull();
    });

    /**
     * The detail endpoint reads the tail asynchronously; a flush in the meantime
     * replaces `events` wholesale, so handing out the live array went stale mid-read.
     */
    it("hands out a copy, not the live buffer", async () => {
      const { spool } = makeSpool();
      spool.push("w1", "s1", [envelope(10, 5)]);

      const warm = spool.warmChunks("w1", "s1")!;
      await spool.flushAll();

      expect(warm.events).toHaveLength(1);
    });

    /**
     * How the detail endpoint notices a flush that landed after it listed storage —
     * the one case where the tail it is holding is already in an object it did not see.
     */
    it("reports how far storage has been written", async () => {
      const { spool } = makeSpool();
      spool.push("w1", "s1", [envelope(10, 1)]);
      expect(spool.warmChunks("w1", "s1")!.flushedThrough).toBeNull();

      await spool.flushAll();
      spool.push("w1", "s1", [envelope(10, 2)]);

      expect(spool.warmChunks("w1", "s1")!.flushedThrough).toBe(1);
    });
  });

  describe("failed flush", () => {
    function failingSpool(failures: number) {
      let attempts = 0;
      const spool = new SessionChunkBuffer({
        chunkFlushMs: 60_000,
        getInitialSequence: async () => 0,
        onChunkFlush: async () => {
          attempts += 1;
          if (attempts <= failures) throw new Error("s3 down");
        },
      });
      return { spool, attempts: () => attempts };
    }

    it("keeps the events for the next attempt", async () => {
      const { spool } = failingSpool(1);
      spool.push("w1", "s1", [envelope(10, 1), envelope(10, 2)]);

      await spool.flushAll().catch(() => {});

      expect(spool.warmChunks("w1", "s1")!.events).toHaveLength(2);
    });

    /**
     * The byte budget is what stops a canvas-heavy page exhausting the process. Zeroing
     * the counter while putting the events back left that session permanently
     * un-capped: every later push was measured against a total of zero.
     */
    it("keeps charging the restored events against the byte budget", async () => {
      const { spool } = failingSpool(1);
      // Two pushes of ~4MB, so the retained total is well clear of rounding.
      spool.push("w1", "s1", [envelope(4_000_000, 1)]);
      await spool.flushAll().catch(() => {});
      spool.push("w1", "s1", [envelope(4_000_000, 2)]);

      // 32MB budget: eight more of these must trip the drop, which cannot happen if the
      // failed flush reset the count.
      for (let i = 0; i < 8; i++) spool.push("w1", "s1", [envelope(4_000_000, 3 + i)]);

      expect(warnings.some((w) => w.msg === "replay_spool_byte_overflow_drop")).toBe(true);
    });

    it("succeeds on a later attempt without losing the original events", async () => {
      const flushes: Flush[] = [];
      let attempts = 0;
      const spool = new SessionChunkBuffer({
        chunkFlushMs: 60_000,
        getInitialSequence: async () => 0,
        onChunkFlush: async (websiteId, sessionId, sequence, events) => {
          attempts += 1;
          if (attempts === 1) throw new Error("s3 down");
          flushes.push({ websiteId, sessionId, sequence, count: events.length });
        },
      });
      spool.push("w1", "s1", [envelope(10, 1), envelope(10, 2)]);

      await spool.flushAll().catch(() => {});
      await spool.flushAll();

      expect(flushes).toEqual([{ websiteId: "w1", sessionId: "s1", sequence: 0, count: 2 }]);
    });
  });
});
