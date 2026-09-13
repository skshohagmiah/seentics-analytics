import { applyBatchOnce } from "../../../platform/idempotency";
import type { TrackerEvent } from "../../../platform/lib/types";
import { ingestAnalyticsBatch } from "../repositories/analytics-batch.repository";
import { trackerRowsToAnalytics } from "./tracker-mapping";
import type { AnalyticsIngestWriter } from "../interfaces";

/**
 * The ingest write path, as analytics offers it.
 *
 * Two jobs, both this module's own. It maps the tracker's wire format into
 * `analytics_events` rows — which used to happen in `collect-handlers.ts`, giving ingest
 * the input schema of a table it does not own. And it makes the batch replay-safe: the
 * insert and the `ingest_applied_batches` marker share one transaction, so a redelivery of
 * the same `batchId` finds the marker, skips the insert, and reports zero rows.
 *
 * Without the marker the queue's retry duplicates every pageview in the batch —
 * `analytics_events` is a plain insert with no natural key to conflict on.
 */
export class AnalyticsIngestService implements AnalyticsIngestWriter {
  async writeBatch(
    batchId: string,
    websiteId: string,
    events: readonly TrackerEvent[],
  ): Promise<number> {
    const rows = trackerRowsToAnalytics(events);

    const { applied, rowCount } = await applyBatchOnce(batchId, (tx) =>
      ingestAnalyticsBatch(tx, websiteId, rows),
    );
    // A repeat is normal under at-least-once delivery, not an error. Reporting 0 keeps the
    // caller's inserted-row accounting honest.
    return applied ? rowCount : 0;
  }
}
