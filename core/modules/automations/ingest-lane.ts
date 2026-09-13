import type { AppConfig } from "../../config";
import type { LaneSpec } from "../ingest/interfaces";
import type { AutomationTriggerQueued } from "../../platform/lib/types";
import type {
  AutomationTriggerWriter,
  VisitorProfileWrite,
  VisitorProfileWriter,
} from "./interfaces";

/** Automation triggers fired by the tracker, ready for server-side evaluation. */
export function automationsLane(writer: AutomationTriggerWriter): LaneSpec {
  return {
    partitionOf: (row: { websiteId?: string }, websiteId) => row.websiteId ?? websiteId,
    apply: async (batchId, _partitionKey, rows) => {
      await writer.writeTriggers(batchId, rows as AutomationTriggerQueued[]);
    },
    threshold: (cfg: AppConfig) => cfg.ingestQueue.maxAutomationsBeforeForceFlush,
  };
}

/**
 * One visitor profile per `/collect`, coalesced per visitor at apply time.
 *
 * Buffered rather than written inline because it was the single exception to `/collect`
 * touching no database — one un-awaited upsert per request, and since the tracker flushes
 * every few seconds per visitor, also the highest-frequency write in the system.
 *
 * `visit_count` and `total_page_views` accumulate, which is why this lane needs
 * `applyBatchOnce` as much as heatmaps does: a redelivery inflates a number rather than
 * duplicating a row.
 */
export function profilesLane(writer: VisitorProfileWriter): LaneSpec {
  return {
    partitionOf: (row: { websiteId?: string }, websiteId) => row.websiteId ?? websiteId,
    apply: (batchId, _partitionKey, rows) =>
      writer.writeBatch(batchId, rows as readonly VisitorProfileWrite[]),
    threshold: (cfg: AppConfig) => cfg.ingestQueue.maxProfilesBeforeForceFlush,
  };
}
