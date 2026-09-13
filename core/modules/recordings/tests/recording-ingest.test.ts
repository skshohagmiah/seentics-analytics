import { describe, it, expect, beforeEach, mock } from "bun:test";
// Registers the shared infrastructure stubs. Must come before the modules under test.
import { resetStubs } from "./support/stubs";
import type { TrackerEvent } from "../../../platform/lib/types";

/**
 * The engine's own behaviour, with storage and the database stubbed.
 *
 * Worth its own file because everything it decides is derived, not stored: duration,
 * page count, rage clicks and the redelivery guard are all computed here and only
 * observable through the row it hands the repository.
 */

type WrittenRow = Record<string, unknown>;
const written: { batchId: string; rows: WrittenRow[] }[] = [];
let upsertThrows = false;

/**
 * Every runtime export, not just the one this file drives — see
 * `app/tests/mock-completeness.test.ts` for why a partial global stub breaks other files.
 */
mock.module("../repositories/recording.repository", () => ({
  upsertSessionMetaBatch: async (_tx: unknown, batchId: string, rows: WrittenRow[]) => {
    if (upsertThrows) throw new Error("pg exploded");
    written.push({ batchId, rows });
    return rows.length;
  },
  listSessions: async () => [],
  summarizeSessions: async () => [],
  getSessionMeta: async () => null,
  deleteSession: async () => 0,
}));

/** Stands in for the marker table: same batch id twice means the second is a repeat. */
const seenBatches = new Set<string>();
/**
 * Every runtime export of the module, not just `applyBatchOnce`.
 *
 * `mock.module` applies to the whole run, so this stub replaces the idempotency module
 * for every file loaded after it — an omission fails somewhere unrelated with a
 * `SyntaxError` pointing at the real file that does export the name.
 */
mock.module("../../../platform/idempotency", () => ({
  applyBatchOnceSql: async (_batchId: string, write: () => Promise<number>) =>
    ({ applied: true, rowCount: await write() }),
  batchIdFromContent: (...parts: unknown[]) => parts.join(":"),
  serializeBatch: (rows: unknown[]) => ({ json: JSON.stringify(rows), batchId: "batch" }),
  applyBatchOnce: async (batchId: string, write: (tx: unknown) => Promise<number>) => {
    if (seenBatches.has(batchId)) return { applied: false, rowCount: 0 };
    const rowCount = await write({});
    // Recorded only on success, exactly as the transaction's rollback would.
    seenBatches.add(batchId);
    return { applied: true, rowCount };
  },
}));

const { RecordingIngestService } = await import("../services/recording-ingest.service");

const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

function rrweb(ts: number, opts: { type?: number; url?: string; inner?: Record<string, unknown> } = {}): TrackerEvent {
  return {
    type: "rrweb",
    ts,
    url: opts.url ?? "https://x.test/a",
    sid: "s1",
    vid: "v1",
    websiteId: "w1",
    data: { type: opts.type ?? 3, timestamp: ts, data: opts.inner ?? {} },
  } as TrackerEvent;
}

function click(ts: number, x: number, y: number, url = "https://x.test/a"): TrackerEvent {
  return rrweb(ts, { type: 3, url, inner: { source: 2, type: 2, x, y } });
}

/** The single row the engine produced for `sessionId`, across every write. */
function rowFor(sessionId: string): WrittenRow | undefined {
  return written.flatMap((w) => w.rows).find((r) => r.sessionId === sessionId);
}

function makeEngine() {
  return new RecordingIngestService();
}

describe("RecordingIngestService.processEvents", () => {
  beforeEach(() => {
    written.length = 0;
    seenBatches.clear();
    upsertThrows = false;
    resetStubs();
  });

  describe("event selection", () => {
    it("ignores events that are not part of a recording", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [
        { type: "pageview", ts: T0, sid: "s1", websiteId: "w1", data: {} } as TrackerEvent,
      ]);
      expect(written).toEqual([]);
    });

    it("drops events with no session id — a chunk with no session has nothing to attach to", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [
        { type: "rrweb", ts: T0, sid: "", websiteId: "w1", data: { type: 2, timestamp: T0 } } as TrackerEvent,
      ]);
      expect(written).toEqual([]);
    });

    it("records a session that has only errors and network events", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [
        { type: "session_error", ts: T0, sid: "s1", url: "https://x.test/a", websiteId: "w1", data: { message: "boom" } } as TrackerEvent,
      ]);
      expect(rowFor("s1")).toMatchObject({ hasErrors: true, entryPage: "https://x.test/a" });
    });
  });

  describe("duration", () => {
    it("spans the widest activity in the batch, not just DOM mutations", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [
        rrweb(T0, { type: 2 }),
        { type: "console_event", ts: T0 + 45_000, sid: "s1", websiteId: "w1", data: { level: "log", args: [] } } as TrackerEvent,
      ]);
      expect(rowFor("s1")).toMatchObject({ durationSeconds: 45 });
    });

    it("is zero for a single-event session rather than negative or NaN", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [rrweb(T0, { type: 2 })]);
      expect(rowFor("s1")).toMatchObject({ durationSeconds: 0 });
    });
  });

  describe("client timestamps", () => {
    /**
     * `latestEventMs` becomes `_snc_re_end` in the row's jsonb and is cast to `bigint`
     * in the upsert's conflict clause. A fractional or out-of-range value aborts that
     * whole statement, taking every other session batched with it.
     */
    it("truncates a fractional rrweb timestamp", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [rrweb(T0, { type: 2 }), rrweb(T0 + 1000.5)]);
      const end = rowFor("s1")!.latestEventMs as number;
      expect(Number.isInteger(end)).toBe(true);
    });

    it("falls back to the envelope ts for an out-of-range rrweb timestamp", async () => {
      const engine = makeEngine();
      const ev = rrweb(T0 + 5_000);
      (ev.data as Record<string, unknown>).timestamp = 1e21;
      await engine.processEvents("b1", [rrweb(T0, { type: 2 }), ev]);
      const row = rowFor("s1")!;
      expect(Number.isInteger(row.latestEventMs)).toBe(true);
      expect(row.latestEventMs).toBe(T0 + 5_000);
    });

    it("ignores a non-numeric rrweb timestamp instead of storing NaN", async () => {
      const engine = makeEngine();
      const ev = rrweb(T0 + 2_000);
      (ev.data as Record<string, unknown>).timestamp = "not-a-number";
      await engine.processEvents("b1", [rrweb(T0, { type: 2 }), ev]);
      const row = rowFor("s1")!;
      expect(Number.isFinite(row.latestEventMs)).toBe(true);
      expect(row.durationSeconds).toBe(2);
    });
  });

  describe("pages viewed", () => {
    it("counts URL transitions, not full snapshots", async () => {
      const engine = makeEngine();
      // Two checkpoints on the same page: `checkoutEveryNms` fires one a minute, and
      // counting snapshots inflated the page count by roughly one per minute.
      await engine.processEvents("b1", [
        rrweb(T0, { type: 2, url: "https://x.test/a" }),
        rrweb(T0 + 60_000, { type: 2, url: "https://x.test/a" }),
      ]);
      expect(rowFor("s1")).toMatchObject({ urlTransitions: 0 });
    });

    it("counts a real navigation", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [
        rrweb(T0, { type: 2, url: "https://x.test/a" }),
        rrweb(T0 + 1_000, { url: "https://x.test/b" }),
      ]);
      expect(rowFor("s1")).toMatchObject({
        urlTransitions: 1,
        firstUrl: "https://x.test/a",
        lastUrl: "https://x.test/b",
      });
    });

    it("treats query and hash churn as the same page", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [
        rrweb(T0, { type: 2, url: "https://x.test/a?q=1" }),
        rrweb(T0 + 1_000, { url: "https://x.test/a#section" }),
      ]);
      expect(rowFor("s1")).toMatchObject({ urlTransitions: 0 });
    });
  });

  describe("rage clicks", () => {
    it("flags three fast clicks in a small area", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [
        rrweb(T0, { type: 2 }),
        click(T0 + 100, 50, 50),
        click(T0 + 300, 52, 51),
        click(T0 + 500, 54, 53),
      ]);
      expect(rowFor("s1")).toMatchObject({ hasRageClicks: true });
    });

    it("does not flag clicks spread beyond a second", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [
        rrweb(T0, { type: 2 }),
        click(T0 + 100, 50, 50),
        click(T0 + 1_500, 52, 51),
        click(T0 + 3_000, 54, 53),
      ]);
      expect(rowFor("s1")).toMatchObject({ hasRageClicks: false });
    });

    it("does not flag fast clicks far apart on the page", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [
        rrweb(T0, { type: 2 }),
        click(T0 + 100, 10, 10),
        click(T0 + 200, 400, 400),
        click(T0 + 300, 800, 800),
      ]);
      expect(rowFor("s1")).toMatchObject({ hasRageClicks: false });
    });
  });

  describe("durability", () => {
    /**
     * The write used to be buffered onto a timer that nobody awaited, so the ingest
     * worker marked the batch applied whether or not the row ever landed — and chunks
     * with no `sequence = 0` row are invisible to the list, undeletable, and unreachable
     * by retention.
     */
    it("throws when the metadata write fails, so the batch is retried", async () => {
      const engine = makeEngine();
      upsertThrows = true;
      await expect(engine.processEvents("b1", [rrweb(T0, { type: 2 })])).rejects.toThrow(
        "pg exploded",
      );
    });

    it("spools nothing when the metadata write fails", async () => {
      const engine = makeEngine();
      upsertThrows = true;
      await engine.processEvents("b1", [rrweb(T0, { type: 2 })]).catch(() => {});
      expect(engine.warmChunks("w1", "s1")).toBeNull();
    });

    it("retrying after a failed write spools the events exactly once", async () => {
      const engine = makeEngine();
      upsertThrows = true;
      await engine.processEvents("b1", [rrweb(T0, { type: 2 }), rrweb(T0 + 1_000)]).catch(() => {});
      upsertThrows = false;
      await engine.processEvents("b1", [rrweb(T0, { type: 2 }), rrweb(T0 + 1_000)]);
      expect(engine.warmChunks("w1", "s1")?.events).toHaveLength(2);
    });
  });

  describe("redelivery", () => {
    it("writes metadata once for a repeated batch id", async () => {
      const engine = makeEngine();
      const events = [rrweb(T0, { type: 2 }), rrweb(T0 + 1_000, { url: "https://x.test/b" })];
      await engine.processEvents("b1", events);
      await engine.processEvents("b1", events);
      expect(written).toHaveLength(1);
    });

    /** `pages_viewed` accumulates in SQL, so a second spool push would double the events too. */
    it("does not spool a repeated batch a second time", async () => {
      const engine = makeEngine();
      const events = [rrweb(T0, { type: 2 }), rrweb(T0 + 1_000)];
      await engine.processEvents("b1", events);
      await engine.processEvents("b1", events);
      expect(engine.warmChunks("w1", "s1")?.events).toHaveLength(2);
    });

    it("still applies a genuinely different batch", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [rrweb(T0, { type: 2 })]);
      await engine.processEvents("b2", [rrweb(T0 + 1_000)]);
      expect(written).toHaveLength(2);
    });
  });

  describe("ordering", () => {
    it("stamps the batch id it was called with", async () => {
      const engine = makeEngine();
      await engine.processEvents("batch-xyz", [rrweb(T0, { type: 2 })]);
      expect(written[0]!.batchId).toBe("batch-xyz");
    });

    it("groups a mixed batch into one row per session", async () => {
      const engine = makeEngine();
      const other = rrweb(T0, { type: 2 });
      other.sid = "s2";
      await engine.processEvents("b1", [rrweb(T0, { type: 2 }), other]);
      expect(written[0]!.rows).toHaveLength(2);
    });

    it("sorts spooled events by the replay timeline, not arrival order", async () => {
      const engine = makeEngine();
      await engine.processEvents("b1", [rrweb(T0 + 5_000), rrweb(T0, { type: 2 }), rrweb(T0 + 1_000)]);
      const tail = engine.warmChunks("w1", "s1")!.events;
      const stamps = tail.map((e) => (e.data as Record<string, number>).timestamp);
      expect(stamps).toEqual([T0, T0 + 1_000, T0 + 5_000]);
    });
  });
});
