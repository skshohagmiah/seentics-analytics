import type { AppConfig } from "../../config";
import type { LaneSpec } from "../ingest/interfaces";
import type { TrackerEvent } from "../../platform/lib/types";
import type { RecordingIngest } from "./interfaces";

/**
 * rrweb DOM events plus the console, network and error annotations recorded beside them.
 *
 * **Partitioned by session, not website** — the one lane where the key is load-bearing
 * rather than fair. Chunk sequences are assigned per session, so two batches for one
 * session applied concurrently overwrite each other's objects in storage.
 */
export function recordingsLane(ingest: () => RecordingIngest): LaneSpec {
  return {
    partitionOf: (row: { sid?: string }) => row.sid ?? "",
    apply: (batchId, _partitionKey, rows) =>
      ingest().processEvents(batchId, rows as TrackerEvent[]),
    threshold: (cfg: AppConfig) => cfg.ingestQueue.maxRecordingsBeforeForceFlush,
  };
}
