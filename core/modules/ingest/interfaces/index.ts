/**
 * Public contracts for the ingest module.
 *
 * `LaneSpec` is the notable one: each feature declares its own ingest — partitioning,
 * back-pressure, write — and ingest supplies only the machinery that is genuinely generic
 * (buffering, the durable queue, claim, retry, park).
 *
 * `TrackerWebsites` used to be declared here. It moved to `modules/websites` once the
 * implementation did — three modules consume it, so the provider owns the contract.
 */
export type {
  BatchQueue,
  IngestFlusher,
  IngestLane,
  IngestQueue,
  LaneRegistry,
  LaneSpec,
  QueuedBatch,
} from "./ingest.interface";

/** The whole module surface, as a peer receives it at composition time. */
export type { IngestModule } from "./ingest.module";
export type {
  ProcessTrackerCollectInput,
  ProcessTrackerCollectResult,
  TrackerCollectService,
} from "./tracker-collect.interface";
