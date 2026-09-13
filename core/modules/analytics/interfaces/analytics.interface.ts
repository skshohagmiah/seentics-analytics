/**
 * The analytics module's public surface, split by capability.
 *
 * Twenty-nine query surfaces behind one `IAnalyticsModule` would force every
 * consumer to depend on all of it and make any of it impossible to substitute.
 * Grouped this way, the automations module can take `AnalyticsRealtime` alone,
 * and a test can stub that one interface with three methods instead of thirty.
 *
 * Read models are returned in wire shape (snake_case) because these endpoints are
 * consumed directly by the dashboard and the field names are part of the public
 * contract. They are typed as `Record<string, unknown>`-free concrete shapes only
 * where a peer module actually reads them; the rest stay opaque to keep this file
 * from becoming a duplicate of every SQL projection.
 */

import type { AnalyticsIngestEvent, TrackerEvent } from "../../../platform/lib/types";

/** Query parameters common to the windowed analytics endpoints. */
export type AnalyticsWindow = {
  /** Trailing window in days. Clamped to 1–365; defaults per endpoint. */
  days?: string;
  /** IANA timezone for day bucketing. Invalid values fall back to UTC. */
  timezone?: string;
  limit?: string;
};

/** Raw query bag as it arrives from the HTTP layer. */
export type AnalyticsQueryParams = Record<string, string | undefined>;

/**
 * Headline figures and time series for one site.
 *
 * The dashboard's primary read path — cache-sensitive and the most-hit surface
 * in the product.
 */
export interface AnalyticsDashboard {
  getDashboard(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getTrafficSummary(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getDailyStats(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getHourlyStats(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
}

/**
 * Breakdowns by a single attribute — pages, sources, geography, device.
 *
 * `getDimensionsBulk` answers several of these in one round trip; prefer it when
 * rendering a dashboard that needs more than two breakdowns at once.
 */
export interface AnalyticsDimensions {
  getPages(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getReferrers(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getSources(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getBrowsers(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getDevices(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getOperatingSystems(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getCountries(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getCities(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getLanguages(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getResolutions(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getGeolocation(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getPageUtmBreakdown(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getDimensionsBulk(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
}

/**
 * Live and near-live views.
 *
 * These read the most recent minutes of data, so they are the surfaces most
 * affected by ingest batching latency — a visitor appears here one flush after
 * their first event, not instantly.
 *
 * Unlike the windowed endpoints these take explicit, already-validated options
 * rather than a raw query bag: their windows are in minutes rather than days, and
 * the route validates `within_minutes` and `limit` with a schema before calling.
 */
export interface AnalyticsRealtime {
  /** Fixed 30-minute window; takes no options. */
  getRealtime(websiteRef: string): Promise<unknown>;

  /** Fixed windows — 30s live, 30min active. Takes no options. */
  getLiveVisitors(websiteRef: string): Promise<unknown>;

  getRealtimeGeo(
    websiteRef: string,
    opts?: { withinMinutes?: number },
  ): Promise<unknown>;

  getRecentActivity(
    websiteRef: string,
    limit: number,
    opts?: { withinMinutes?: number },
  ): Promise<unknown>;

}

/** Journey and per-visitor analysis. */
export interface AnalyticsBehaviour {
  getActivityTrends(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getPathAnalysis(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getVisitorInsights(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
  getCustomEvents(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
}

/** Goal conversion reporting. */
export interface AnalyticsGoals {
  getGoals(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
}

/** Revenue and monetisation reporting. */
export interface AnalyticsRevenue {
  getRevenueDashboard(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
}

/** Bulk data extraction. */
export interface AnalyticsExport {
  exportEvents(websiteId: string, query: AnalyticsQueryParams): Promise<unknown>;
}

/**
 * The unauthenticated public dashboard.
 *
 * Keyed by `publicShareId` rather than a site id, and resolves that itself —
 * the caller is anonymous and has no website reference to offer. `null` when the
 * share link is unknown or has been revoked.
 */
export interface AnalyticsPublicDashboard {
  getPublicDashboard(publicShareId: string, query: AnalyticsQueryParams): Promise<unknown | null>;
}

/**
 * The ingest write path.
 *
 * Declared here so the ingest module can hand a flushed batch to analytics
 * without importing `repositories/analytics-batch.repository` — which is what it
 * used to do, and which meant a module that only buffers events had a compile-time
 * dependency on how analytics rows are written.
 *
 * `writeBatch` is retried by the queue on a throw, so it must not partially commit
 * and then fail; the returned count can be lower than the input after
 * de-duplication.
 */
export interface AnalyticsIngestWriter {
  /**
   * Persist a batch, exactly once.
   *
   * `batchId` must be stable across every redelivery of the same rows. The write records
   * it and skips a repeat, which is what makes the queue's retry safe:
   * `analytics_events` is a plain insert with no natural key, so a replayed batch would
   * otherwise duplicate every pageview.
   *
   * Returns the rows actually written — 0 for a batch already applied, and possibly
   * fewer than the input after non-analytics event types are filtered out.
   */
  writeBatch(
    batchId: string,
    websiteId: string,
    /**
     * Raw tracker events, exactly as the tracker sent them.
     *
     * Not this module's row shape: mapping happens inside the writer, so a queued batch
     * carries the tracker's wire format rather than `analytics_events`' projection. The
     * queue is durable, so anything in that payload is a stored contract — and this
     * module's column layout has no business being one.
     */
    events: readonly TrackerEvent[],
  ): Promise<number>;
}

/**
 * The whole authenticated read surface, as one alias.
 *
 * For callers that genuinely expose all of it — the analytics router and the raw
 * API — and no one else. A peer module taking this instead of the one capability it
 * uses is the mistake the split above exists to prevent; the alias is a convenience
 * for the two HTTP surfaces that really are a thin pass-through over every method,
 * not a re-merged `IAnalyticsModule`.
 */
export type AnalyticsReads = AnalyticsDashboard &
  AnalyticsDimensions &
  AnalyticsRealtime &
  AnalyticsBehaviour &
  AnalyticsGoals &
  AnalyticsRevenue &
  AnalyticsExport;

/**
 * Recent pageview URLs for a site, newest first.
 *
 * A port because heatmaps needs it and `analytics_events` is analytics-owned. Heatmaps
 * used to hold its own query against that table — `repositories/pageview-url.repository.ts`,
 * whose own comment called itself "one import to delete when analytics grows a port
 * for it". This is that port.
 *
 * Takes the website UUID — the same id the tracker is installed with and every other
 * table is keyed by. An earlier version of this comment said `analytics_events.website_id`
 * held a separate short public id; that stopped being true when websites were unified
 * onto one identifier, and the note survived long enough to be worth correcting rather
 * than deleting.
 */
export interface AnalyticsPageviewUrls {
  listRecentPageviewUrls(websiteId: string): Promise<string[]>;
}

/**
 * The raw event feed behind `/api/v1/raw`.
 *
 * A port because the raw API is a platform-level HTTP surface, and the projection it
 * returns is a view of `analytics_events`. `platform/public-api/raw-data.service.ts` used
 * to hold this query itself, which put a Drizzle projection of this module's table in
 * shared code where a schema change would break it silently.
 *
 * Takes the website UUID, like every other read on this table.
 */
export interface AnalyticsRawEvents {
  listRawEvents(
    websiteId: string,
    q: {
      from?: Date;
      to?: Date;
      limit: number;
      offset: number;
      eventType?: string;
    },
  ): Promise<
    Array<{
      id: string;
      event_type: string;
      page: string | null;
      visitor_id: string | null;
      session_id: string | null;
      occurred_at: string;
      properties: unknown;
    }>
  >;
}

/**
 * Tracker funnel events, bucketed by step.
 *
 * The funnels module owns funnel *definitions*; the events land in `analytics_events`
 * like everything else the tracker sends, so the aggregation belongs here. Funnels held
 * this query itself until the table's owner grew a port for it.
 *
 * `funnel_complete` rows bucket to `step_order = -1`; `funnel_step` rows to their
 * `properties->>'step'` index. Counts are of distinct visitors — falling back to the
 * session when the tracker sent no visitor id — which is what makes the conversion rate
 * a people rate rather than an event rate.
 */
export interface AnalyticsFunnelEvents {
  countFunnelStepVisitors(
    websiteId: string,
    funnelId: string,
    startIso: string,
    endIso: string,
  ): Promise<Array<{ step_order: number | null; cnt: number }>>;
}
