import type { HeatmapIngestEvent } from "../../../platform/lib/types";
import type { HeatmapTrackerEvent } from "../interfaces";

/** Mapping from tracker wire events into the heatmap ingest domain. */

/**
 * A tracker event with the per-request context heatmaps needs attached.
 *
 * Both extra fields have to be per *event*, not per batch: the ingest buffer accumulates
 * across requests, so it holds events from many visitors (different user agents) and many
 * websites (different layout settings) at once.
 */
/** The event types this module claims off a mixed tracker batch. */
const HEATMAP_TYPES = new Set([
  "heatmap_click",
  "heatmap_scroll",
  "heatmap_screenshot",
  "heatmap_dom_snapshot",
]);

/**
 * Raw tracker events → this module's ingest shape.
 *
 * Lived in `modules/ingest/services/collect-handlers.ts` as three near-identical
 * `collectPrepare*` functions. Both halves of what they did belong here rather than in
 * ingest: the field projection (`doc_w` → `docW`) is this module's column naming, and
 * knowing that `heatmap_click` is a heatmap event is this module's domain. Ingest's job is
 * to buffer and route, not to know either.
 *
 * Filtering here also means a batch that turns out to hold no heatmap events costs nothing
 * downstream — the engine sees an empty array and returns.
 */
export function trackerRowsToHeatmapEvents(
  rows: readonly HeatmapTrackerEvent[],
): HeatmapIngestEvent[] {
  const out: HeatmapIngestEvent[] = [];
  for (const e of rows) {
    if (!HEATMAP_TYPES.has(e.type)) continue;
    out.push({
      type: e.type,
      data: e.data ?? {},
      ts: e.ts,
      url: e.url,
      sid: e.sid,
      vid: e.vid,
      websiteId: e.websiteId,
      clientUa: e.clientUa,
      // Only the layout-bearing types carry this; clicks and scrolls ignore it.
      heatmapLayoutEnabled: e.heatmapLayoutEnabled ?? false,
      docW: e.doc_w,
      docH: e.doc_h,
    });
  }
  return out;
}
