import type { LaneSpec } from "../../ingest/interfaces";
import type { AuthedRouter } from "../../../platform/http/router";
import type { UsageCounter } from "../../../platform/usage";
import type { RetentionPurge } from "../../../platform/retention";
import type {
  AnalyticsIngestWriter,
  AnalyticsFunnelEvents,
  AnalyticsPageviewUrls,
  AnalyticsRawEvents,
  AnalyticsPublicDashboard,
  AnalyticsReads,
  TrafficSummary,
} from "./index";

/**
 * Everything the analytics module offers, in one interface.
 *
 * `getTrafficSummary` is on the module itself rather than behind a separate port,
 * because the websites module calls exactly that one method and nothing else here.
 * It is the only cross-module read on this interface that is not a sub-interface, and
 * it is why the websites list can show pageview counts without websites knowing that
 * `analytics_events` exists.
 */
export interface AnalyticsModule {
  /**
   * This module's ingest lanes, for the composition root to register.
   *
   * Two, not one: funnel events go to the same writer and the same table, but travel in
   * their own lane so a funnel backlog cannot delay pageview writes.
   */
  lanes: { analytics: LaneSpec; funnels: LaneSpec };

  /**
   * Trailing-30-day figures for many sites at once, keyed by `websiteId`.
   *
   * Batched rather than per-site because the caller renders every site the user owns;
   * a per-site call there is an N+1 on the dashboard's landing page. Sites with no
   * traffic may be absent from the map — treat absence as zero, not as an error.
   */
  getTrafficSummary(websiteIds: string[]): Promise<Map<string, TrafficSummary>>;

  /** The full authenticated read surface, used by this module's routes and the raw API. */
  reads: AnalyticsReads;

  /** The unauthenticated public dashboard, keyed by share id. */
  publicDashboard: AnalyticsPublicDashboard;

  /** Where ingest hands a flushed batch of events. */
  ingest: AnalyticsIngestWriter;

  /** Recent pageview URLs, for heatmaps' screenshot-target fallback. */
  pageviewUrls: AnalyticsPageviewUrls;

  /** The raw event feed behind `/api/v1/raw`. */
  rawEvents: AnalyticsRawEvents;

  /** Tracker funnel events bucketed by step, for funnels' reports. */
  funnelEvents: AnalyticsFunnelEvents;

  /** Deletion of this module's own rows, for the retention sweep. */
  retention: RetentionPurge;

  /** This module's contribution to the per-user usage report. */
  usage: UsageCounter;

  routes: AuthedRouter;
}
