import type { LaneSpec } from "../../ingest/interfaces";
import type { AuthedRouter } from "../../../platform/http/router";
import type { UsageCounter } from "../../../platform/usage";
import type { ModuleLifecycle } from "../../../app/module";
import type { RetentionPurge } from "../../../platform/retention";
import type { RecordingIngest, RecordingRawReads } from "./index";

/** Everything the recordings module offers. */
export interface RecordingsModule extends ModuleLifecycle {
  /** This module's ingest lane. Partitioned by session — see `recordingsLane`. */
  lane: LaneSpec;

  /**
   * Where ingest hands raw tracker events, resolved on first use.
   *
   * A function rather than the engine itself because constructing the engine arms
   * flush timers and opens an S3 client. Returning it eagerly would mean building the
   * module started background work, so anything that builds the graph to inspect it —
   * a test, a health probe — would hang on live timers.
   */
  ingest(): RecordingIngest;

  /** Deletion of this module's own rows and stored chunks. */
  retention: RetentionPurge;

  /** This module's contribution to the per-user usage report. */
  usage: UsageCounter;

  /** Reads for the raw API — unmerged projections, not the dashboard's. */
  rawReads: RecordingRawReads;

  routes: AuthedRouter;
}
