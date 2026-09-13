import type { AnalyticsIngestEvent, TrackerEvent } from "../../../platform/lib/types";

/**
 * Raw tracker events → this module's analytics ingest shape.
 *
 * Lived in `modules/ingest/services/collect-handlers.ts` until now, which meant ingest
 * held the input schema of a table it does not own — and once batches became durable rows,
 * that schema would have been a *stored* contract rather than an in-process detail.
 *
 * Worth being honest about how thin this is: `AnalyticsIngestEvent` and `TrackerEvent` are
 * structurally almost the same type, so this drops `websiteId`, `doc_w` and `doc_h` and
 * carries the rest through. The value is ownership, not transformation — the projection
 * into `analytics_events` now lives with the table, so a column change is this module's
 * problem rather than a change to what ingest stores in a durable queue row.
 */
export function trackerRowsToAnalytics(
  rows: readonly TrackerEvent[],
): AnalyticsIngestEvent[] {
  return rows.map((e) => ({
    type: e.type,
    data: e.data,
    ts: e.ts,
    url: e.url,
    sid: e.sid,
    vid: e.vid,
    ingestMeta: e.ingestMeta,
  }));
}
