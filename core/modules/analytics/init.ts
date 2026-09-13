import { analyticsLane, funnelLane } from "./ingest-lane";
import type { AppConfig } from "../../config";
import type { WebsitesModule } from "../websites/interfaces";
import type { AnalyticsModule, TrafficSummary } from "./interfaces";
import { createAnalyticsRoutes } from "./routes";
import { AnalyticsIngestService } from "./services/analytics-ingest.service";
import { AnalyticsExportService } from "./services/analytics-export.service";
import { AnalyticsReadFacade } from "./services/analytics-read-facade.service";
import { ConversionAnalyticsService } from "./services/conversion-analytics.service";
import { DashboardAnalyticsService } from "./services/dashboard-analytics.service";
import { DimensionAnalyticsService } from "./services/dimension-analytics.service";
import { RealtimeAnalyticsService } from "./services/realtime-analytics.service";
import { VisitorJourneyAnalyticsService } from "./services/visitor-journey-analytics.service";
import { AnalyticsPageviewUrlService } from "./services/pageview-url-query.service";
import { AnalyticsEventFeedService } from "./services/raw-analytics-event.service";
import { PublicDashboardService } from "./services/public-dashboard-analytics.service";
import { AnalyticsRetentionPurge } from "./services/retention-purge.service";
import { AnalyticsTrafficSummaryService } from "./services/website-traffic-summary.service";
import { AnalyticsUsageCounter } from "./services/usage-count.service";

/**
 * Build the analytics module.
 *
 * Takes the websites module whole. That is safe because every member of
 * `WebsitesModule` is itself an interface — there is no way to reach the Postgres
 * repository, the cache, or a mutation from here, even though the whole module is in
 * scope. What this module actually uses is two read views and a share-link resolver.
 */
export function initAnalyticsModule(deps: {
  websitesModule: WebsitesModule;
  /** Needed only for the response cache's TTLs and size limits. */
  cfg: AppConfig;
}): AnalyticsModule {
  const { websitesModule } = deps;

  // The cached view: every query here resolves a website reference before it can read
  // anything, so this sits on the hottest path in the module.
  const dashboard = new DashboardAnalyticsService();
  const dimensions = new DimensionAnalyticsService();
  const realtime = new RealtimeAnalyticsService();
  const journeys = new VisitorJourneyAnalyticsService();
  const conversions = new ConversionAnalyticsService();
  const exporter = new AnalyticsExportService();
  const reads = new AnalyticsReadFacade(
    dashboard,
    dimensions,
    realtime,
    journeys,
    conversions,
    exporter,
  );
  const publicDashboard = new PublicDashboardService(websitesModule.sharing);
  const traffic = new AnalyticsTrafficSummaryService();
  const eventFeed = new AnalyticsEventFeedService();

  const ingest = new AnalyticsIngestService();

  return {
    lanes: { analytics: analyticsLane(ingest), funnels: funnelLane(ingest) },

    getTrafficSummary(websiteIds: string[]): Promise<Map<string, TrafficSummary>> {
      return traffic.summarizeSites(websiteIds);
    },

    reads,
    publicDashboard,
    ingest,
    pageviewUrls: new AnalyticsPageviewUrlService(),
    rawEvents: eventFeed,
    funnelEvents: eventFeed,
    retention: new AnalyticsRetentionPurge(),

    usage: new AnalyticsUsageCounter(),
    routes: createAnalyticsRoutes({
      dashboard,
      dimensions,
      realtime,
      journeys,
      conversions,
      exporter,
      publicDashboard,
      // Access checks read through the uncached view on purpose — see `WebsitesModule`.
      websites: websitesModule.accessChecks,
      cfg: deps.cfg,
    }),
  };
}
