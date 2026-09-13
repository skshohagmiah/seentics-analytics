import type { LaneSpec } from "../../ingest/interfaces";
import type { AuthedRouter } from "../../../platform/http/router";
import type { UsageCounter } from "../../../platform/usage";
import type { ModuleLifecycle } from "../../../app/module";
import type { RetentionPurge } from "../../../platform/retention";
import type {
  HeatmapIngest,
  HeatmapScreenshotCapture,
  HeatmapScreenshotMaintenance,
  HeatmapRawReads,
} from "./index";

/** Everything the heatmaps module offers. */
export interface HeatmapsModule extends ModuleLifecycle {
  /** This module's ingest lane. The only one with a byte ceiling — see `heatmapsLane`. */
  lane: LaneSpec;

  /**
   * On-demand Playwright capture, for the tracker's `/request-screenshot`.
   *
   * The only capability here that dials out to the public internet, which is why the
   * caller validates the target URL against the site's own domain first.
   */
  screenshots: HeatmapScreenshotCapture;

  /**
   * Re-capture of stale snapshots, for the scheduler.
   *
   * Deliberately narrower than `screenshots`: it picks targets from rows that already
   * exist and cannot be asked to fetch an arbitrary URL. An unattended caller holding
   * the general capture capability would be a much more attractive thing to
   * compromise.
   */
  maintenance: HeatmapScreenshotMaintenance;

  /** Where ingest hands click/scroll/snapshot events. Lazy — see `RecordingsModule`. */
  ingest(): HeatmapIngest;

  /** Deletion of this module's own rows and stored images. */
  retention: RetentionPurge;

  /** This module's contribution to the per-user usage report. */
  usage: UsageCounter;

  /** Reads for the raw API — unmerged projections, not the dashboard's. */
  rawReads: HeatmapRawReads;

  routes: AuthedRouter;
}
