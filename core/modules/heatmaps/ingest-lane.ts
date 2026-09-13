import type { AppConfig } from "../../config";
import type { LaneSpec } from "../ingest/interfaces";
import type { HeatmapIngest, HeatmapTrackerEvent } from "./interfaces";

/**
 * Clicks and scroll depth, plus the page backgrounds they are drawn on.
 *
 * The only lane with a byte ceiling. A click is tens of bytes and a DOM snapshot is
 * megabytes, so a row count — the cap every other lane uses — cannot tell the difference
 * between a buffer holding two megabytes and one holding eighty gigabytes.
 */
export function heatmapsLane(ingest: () => HeatmapIngest): LaneSpec {
  return {
    partitionOf: (row: { websiteId?: string }, websiteId) => row.websiteId ?? websiteId,
    apply: (batchId, _partitionKey, rows) =>
      ingest().processEvents(batchId, rows as readonly HeatmapTrackerEvent[]),
    threshold: (cfg: AppConfig) => cfg.ingestQueue.maxHeatmapsBeforeForceFlush,
    maxBytes: (cfg: AppConfig) => cfg.ingestQueue.maxHeatmapBytes,
    /**
     * Only the two fields that can be large are measured, because only they can be: an
     * image or an HTML snapshot is a top-level string on `data`, and everything else is a
     * number or a short selector. Walking the whole object would cost more than the cap
     * saves, on the hot enqueue path.
     */
    bytesOf: (rows: readonly { data?: unknown }[]) => {
      let bytes = 0;
      for (const row of rows) {
        const data = row.data as { image?: unknown; html?: unknown } | undefined;
        if (typeof data?.image === "string") bytes += data.image.length;
        if (typeof data?.html === "string") bytes += data.html.length;
        bytes += 256; // envelope, selector, url
      }
      return bytes;
    },
  };
}
