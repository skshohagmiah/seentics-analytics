import type { AppConfig } from "../../config";
import type { LaneSpec } from "../ingest/interfaces";
import type { TrackerEvent } from "../../platform/lib/types";
import type { AnalyticsIngestWriter } from "./interfaces";

/**
 * Pageviews, custom events, performance samples and `identify`.
 *
 * Partitioned by website: these rows are commutative, so the key exists for fairness
 * rather than ordering — one busy site cannot monopolise the lane ahead of every other.
 */
export function analyticsLane(writer: AnalyticsIngestWriter): LaneSpec {
  return {
    partitionOf: (_row, websiteId) => websiteId,
    apply: (batchId, websiteId, rows) =>
      writer.writeBatch(batchId, websiteId, rows as readonly TrackerEvent[]),
    threshold: (cfg: AppConfig) => cfg.ingestQueue.maxEventsBeforeForceFlush,
  };
}

/**
 * Funnel step events.
 *
 * The same writer and the same table as `analytics` — a separate lane only so a funnel
 * backlog cannot delay pageview writes.
 */
export function funnelLane(writer: AnalyticsIngestWriter): LaneSpec {
  return {
    partitionOf: (_row, websiteId) => websiteId,
    apply: (batchId, websiteId, rows) =>
      writer.writeBatch(batchId, websiteId, rows as readonly TrackerEvent[]),
    threshold: (cfg: AppConfig) => cfg.ingestQueue.maxFunnelsBeforeForceFlush,
  };
}
