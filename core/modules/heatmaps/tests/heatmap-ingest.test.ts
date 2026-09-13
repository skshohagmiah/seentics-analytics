import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { HeatmapTrackerEvent } from "../interfaces";
import type { ScreenshotJob } from "../../../platform/lib/types";

process.env.DATABASE_URL ??= "postgres://test-not-connected";

/**
 * The engine's write path.
 *
 * The property under test throughout is durability: `processEvents` must not resolve
 * until everything the batch carries has been written, because `BatchWorker` marks the
 * durable batch completed the moment it does. The engine used to buffer points and drain
 * them on a 400ms timer, so a restart, a full buffer or a failed flush lost data that the
 * queue had already recorded as applied — and none of it was visible beyond a log line.
 *
 * The second property is the one the additive upsert forces: a batch is written whole or
 * not at all. The marker guards a whole batch, and `intensity` *adds*, so a half-applied
 * batch re-inflates the number on redelivery.
 */

const upserts: { rows: unknown[] }[] = [];
let upsertThrowsFor: string | null = null;

mock.module("../repositories/heatmap-writes.repository", () => ({
  batchUpsertPoints: async (_tx: unknown, rows: unknown[]) => {
    upserts.push({ rows });
    return rows.length;
  },
  deleteHeatmaps: async () => {},
}));

/** Batch ids already applied, standing in for the marker table. */
const applied = new Set<string>();

mock.module("../../../platform/idempotency", () => ({
  applyBatchOnceSql: async (batchId: string, write: (tx: unknown) => Promise<number>) => {
    if (upsertThrowsFor === batchId) throw new Error("pg exploded");
    if (applied.has(batchId)) return { applied: false, rowCount: 0 };
    const rowCount = await write({});
    applied.add(batchId);
    return { applied: true, rowCount };
  },
  applyBatchOnce: async () => ({ applied: true, rowCount: 0 }),
  batchIdFromContent: (...parts: unknown[]) => parts.join(":"),
  serializeBatch: (rows: unknown[]) => ({ json: JSON.stringify(rows), batchId: "batch" }),
}));

const { HeatmapIngestService } = await import("../services/heatmap-ingest.service");

/** Records what the engine hands the snapshot half, without touching S3. */
class FakeSnapshots {
  screenshots: ScreenshotJob[] = [];
  domSnapshots: string[] = [];
  failScreenshots = false;
  async storeScreenshot(job: ScreenshotJob) {
    if (this.failScreenshots) throw new Error("s3 exploded");
    this.screenshots.push(job);
  }
  async storeDomSnapshot(ev: { url?: string }) {
    this.domSnapshots.push(ev.url ?? "");
  }
}

const SITE_A = "11111111-1111-4111-8111-111111111111";
const SITE_B = "22222222-2222-4222-8222-222222222222";

function clickRow(websiteId: string, nx = 0.5, ny = 0.5): HeatmapTrackerEvent {
  return {
    websiteId,
    type: "heatmap_click",
    url: "https://example.com/pricing",
    ts: 1_770_000_000_000,
    clientUa: "Mozilla/5.0 (Macintosh)",
    data: { nx, ny, target: "button#buy" },
  } as unknown as HeatmapTrackerEvent;
}

let engine: InstanceType<typeof HeatmapIngestService>;
let snapshots: FakeSnapshots;

beforeEach(() => {
  upserts.length = 0;
  applied.clear();
  upsertThrowsFor = null;
  snapshots = new FakeSnapshots();
  engine = new HeatmapIngestService({ snapshots: snapshots as never });
});

describe("durability", () => {
  /**
   * The regression this file exists for. `BatchWorker` marks the batch completed as
   * soon as this resolves, so anything not yet written at that moment is unrecoverable —
   * the batch will never be redelivered.
   */
  it("writes the batch before resolving", async () => {
    await engine.processEvents("b1", [clickRow(SITE_A)]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.rows).toHaveLength(1);
  });

  it("stores screenshots before resolving", async () => {
    await engine.processEvents("b1", [screenshotRow(SITE_A)]);
    expect(snapshots.screenshots).toHaveLength(1);
  });

  /**
   * A throw is the only way to tell the worker not to mark the batch applied. Swallowing
   * it here reads to the worker exactly like success.
   */
  it("throws when the point write fails, so the worker can retry", async () => {
    upsertThrowsFor = "b1";
    await expect(engine.processEvents("b1", [clickRow(SITE_A)])).rejects.toThrow("pg exploded");
  });

  it("throws when object storage fails, so the worker can retry", async () => {
    snapshots.failScreenshots = true;
    await expect(engine.processEvents("b1", [screenshotRow(SITE_A)])).rejects.toThrow(
      "s3 exploded",
    );
  });

  /**
   * Points commit before the upload is attempted, so the retry that a failed upload
   * causes finds the marker and does not add to `intensity` a second time.
   */
  it("does not re-apply points when a retry follows a storage failure", async () => {
    snapshots.failScreenshots = true;
    await expect(
      engine.processEvents("b1", [clickRow(SITE_A), screenshotRow(SITE_A)]),
    ).rejects.toThrow();
    expect(upserts).toHaveLength(1);

    snapshots.failScreenshots = false;
    await engine.processEvents("b1", [clickRow(SITE_A), screenshotRow(SITE_A)]);

    expect(upserts).toHaveLength(1);
    expect(snapshots.screenshots).toHaveLength(1);
  });

  it("ignores a batch with no heatmap events", async () => {
    await engine.processEvents("b1", []);
    expect(upserts).toEqual([]);
  });
});

describe("batch grouping", () => {
  it("writes each ingest batch separately", async () => {
    await engine.processEvents("b1", [clickRow(SITE_A), clickRow(SITE_A, 0.1, 0.1)]);
    await engine.processEvents("b2", [clickRow(SITE_A, 0.2, 0.2)]);

    expect(upserts).toHaveLength(2);
    expect(upserts.map((u) => u.rows.length)).toEqual([2, 1]);
  });

  it("keeps points from one batch in a single write, across websites", async () => {
    await engine.processEvents("b1", [clickRow(SITE_A), clickRow(SITE_B)]);

    // Grouped by batch, not by website — the marker is per batch.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.rows).toHaveLength(2);
  });

  it("skips a batch the marker has already seen", async () => {
    await engine.processEvents("b1", [clickRow(SITE_A)]);
    upserts.length = 0;

    await engine.processEvents("b1", [clickRow(SITE_A)]);

    expect(upserts).toEqual([]);
  });
});

describe("failure isolation", () => {
  it("still applies a later batch after an earlier one failed", async () => {
    upsertThrowsFor = "b1";
    await expect(engine.processEvents("b1", [clickRow(SITE_A)])).rejects.toThrow();
    await engine.processEvents("b2", [clickRow(SITE_B)]);

    expect(upserts).toHaveLength(1);
    expect((upserts[0]!.rows[0] as { websiteId: string }).websiteId).toBe(SITE_B);
  });
});

describe("routing to the snapshot half", () => {
  it("does not send a DOM snapshot when layout capture is off", async () => {
    await engine.processEvents("b1", [
      {
        websiteId: SITE_A,
        type: "heatmap_dom_snapshot",
        url: "https://example.com/p",
        ts: 1,
        data: { html: "<html>".padEnd(200, "x") },
      } as unknown as HeatmapTrackerEvent,
    ]);

    expect(snapshots.domSnapshots).toEqual([]);
  });
});

/** A payload that survives `decodeScreenshotImage`: JPEG magic bytes and over the size floor. */
const FAKE_JPEG_BASE64 = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(600, 0x41),
]).toString("base64");

function screenshotRow(websiteId: string): HeatmapTrackerEvent {
  return {
    websiteId,
    type: "heatmap_screenshot",
    url: "https://example.com/pricing",
    ts: 1_770_000_000_000,
    heatmapLayoutEnabled: true,
    docW: 1280,
    docH: 900,
    data: { image: `data:image/jpeg;base64,${FAKE_JPEG_BASE64}` },
  } as unknown as HeatmapTrackerEvent;
}
