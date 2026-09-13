import { env } from "../../../config";
import { batchUpsertPoints } from "../repositories/heatmap-writes.repository";
import type { HeatmapIngestEvent, HeatmapPointRow, ScreenshotJob } from "../../../platform/lib/types";
import { applyBatchOnceSql } from "../../../platform/idempotency";
import type { HeatmapIngest } from "../interfaces";
import { eventsToPoints, eventsToScreenshotJobs } from "./point-mapping";
import { SnapshotIngestService } from "./snapshot-ingest.service";
import { trackerRowsToHeatmapEvents, type HeatmapTrackerEvent } from "./tracker-mapping";
import type { TrackerWebsites } from "../../websites/interfaces";
import { log as baseLog } from "../../../platform/lib/logger";

const log = baseLog.child({ category: "heatmap" });

/** Concurrent object-storage writes, so one slow S3 put does not serialize a batch. */
const storageConcurrency = 3;

/**
 * The tracker ingest path for heatmap data.
 *
 * **Every write this makes is complete before `processEvents` resolves.** That is the
 * whole contract, and it used to be the opposite: points went into an in-memory array
 * drained by a 400ms timer, so `processEvents` returned — and `BatchWorker` set
 * `completed_at` on the durable batch — while the data was still only in RAM. Three
 * things then lost it silently. A restart inside the timer window dropped the buffer, and
 * the batch was already completed so it was never redelivered. A full buffer dropped rows
 * with a `warn`. A failed flush logged and returned, requeueing nothing. In all three the
 * queue row said applied and the points did not exist.
 *
 * So there is no buffer here now. Batching already happened upstream — `CollectBuffer`
 * accumulates across requests and `ingest_batches` holds the result — and a second layer of
 * it here bought nothing except a window in which acknowledged data was not yet durable. A
 * throw propagates to the worker, which retries the batch and parks it after
 * `maxAttempts` rather than marking it applied.
 *
 * Points are written before object storage on purpose. They are the transactional half and
 * the cheap half, so a retry driven by a failed upload skips them via the batch marker
 * instead of redoing them.
 */
export class HeatmapIngestService implements HeatmapIngest {
  private readonly snapshots: SnapshotIngestService;

  /**
   * Named rather than positional, so a caller supplies only what it has.
   *
   * Both are optional and unrelated, which positionally meant `new HeatmapIngestService(null,
   * snapshots)` — a `null` that says nothing about what it stands for, and that read as a
   * leftover once the event bus this class used to take was removed.
   */
  constructor(opts: {
    /**
     * Resolves the website before an auto-capture, so the SSRF guard can check the
     * target against the site's registered domain. Handed straight to the snapshot
     * service, which is the only thing that captures. Omitted means auto-capture is
     * skipped rather than performed unguarded.
     */
    websites?: TrackerWebsites | null;
    /**
     * Where page backgrounds go. Optional because the two real callers
     * (`heatmapIngestService`, `createHeatmapIngestService`) have no reason to build one — but a test
     * does, and constructing the default reads `env().s3.bucket`, which means a database
     * URL and a bucket just to exercise a write.
     */
    snapshots?: SnapshotIngestService;
  } = {}) {
    this.snapshots =
      opts.snapshots ?? new SnapshotIngestService(env().s3.heatmapBucket, opts.websites ?? null);
  }

  /**
   * Nothing is buffered, so there is nothing to drain.
   *
   * Kept because `initHeatmapsModule().stop` calls it and the interface declares it —
   * and because a future implementation that does buffer would need it back.
   */
  async shutdown(): Promise<void> {}

  /**
   * Ingest one queued batch. Each event must carry a website UUID.
   *
   * Throws if any write fails, which is what lets the worker retry the batch. Do not
   * catch and log in here: a swallowed error is indistinguishable to the worker from a
   * successful apply, and it will mark the batch completed.
   */
  async processEvents(batchId: string, raw: readonly HeatmapTrackerEvent[]): Promise<void> {
    // Projection and type-filtering happen here, not in ingest: the column naming and the
    // set of heatmap event types are both this module's knowledge.
    const events = trackerRowsToHeatmapEvents(raw);
    if (events.length === 0) return;

    await this.writePoints(batchId, eventsToPoints(events));

    // Object storage after the transactional write, and outside the marker: S3 puts are
    // keyed by content or by (website, path), so replaying one overwrites rather than
    // duplicates. Only the additive `intensity` upsert needs the marker.
    await this.storeDomSnapshots(events);
    await this.storeScreenshots(events);

  }

  /**
   * Upsert the batch's points, guarded by the batch marker. A redelivery the marker
   * already covered is a no-op, not an error.
   */
  private async writePoints(batchId: string, rows: HeatmapPointRow[]): Promise<void> {
    if (rows.length === 0) return;
    const { applied } = await applyBatchOnceSql(batchId, (tx) =>
      batchUpsertPoints(tx, rows),
    );
    if (!applied) {
      log.debug({ msg: "heatmap_batch_redelivered", batch_id: batchId, points: rows.length });
    }
  }

  private async storeDomSnapshots(events: readonly HeatmapIngestEvent[]): Promise<void> {
    const pending = events.filter((e) => e.type === "heatmap_dom_snapshot" && e.heatmapLayoutEnabled);
    await mapWithConcurrency(pending, storageConcurrency, (ev) => this.snapshots.storeDomSnapshot(ev));
  }

  private async storeScreenshots(events: readonly HeatmapIngestEvent[]): Promise<void> {
    const jobs: ScreenshotJob[] = [];
    for (const ev of events) {
      if (ev.type !== "heatmap_screenshot" || !ev.heatmapLayoutEnabled) continue;
      /*
       * Straight from the event's own `websiteId`.
       *
       * This was a `Promise.all` over a ternary that tested `ev.websiteId`, and on the
       * false branch tested it again before calling a `siteIdFor` lookup — so the lookup
       * was unreachable and the whole resolution round trip never happened. A leftover
       * from when a website had a second `site_id` identifier; there is one id now.
       */
      if (!ev.websiteId) continue;
      jobs.push(...eventsToScreenshotJobs(ev.websiteId, [ev]));
    }
    await mapWithConcurrency(jobs, storageConcurrency, (job) => this.snapshots.storeScreenshot(job));
  }

}

/**
 * Run `fn` over every item with at most `limit` in flight, rejecting if any does.
 *
 * `Promise.all` over the whole list would open one connection or socket per event, and a
 * batch can carry thousands. Rejecting rather than collecting failures is deliberate:
 * the caller's contract is that a throw means the batch was not applied.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

let _engine: HeatmapIngestService | null = null;

/**
 * The process-wide service.
 *
 * Still an accessor rather than an injected dependency because its callers — this
 * module's own lane and its shutdown hook — are module-level and have nothing to inject
 * through. Creates a bus-less instance if nothing initialized one first, so ingest keeps
 * working whether or not events are wired.
 */
export function heatmapIngestService(): HeatmapIngestService {
  if (!_engine) _engine = new HeatmapIngestService();
  return _engine;
}

/**
 * Create it with the website lookup its SSRF guard needs. Called by
 * `initHeatmapsModule().start` before anything can ingest; returns the same instance
 * `heatmapIngestService()` will hand out.
 */
export function createHeatmapIngestService(websites: TrackerWebsites): HeatmapIngestService {
  _engine = new HeatmapIngestService({ websites });
  return _engine;
}
