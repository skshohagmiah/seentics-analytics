import { analyticsLane, funnelLane } from "./ingest-lane";
import type { AppConfig } from "../../config";
import type { WebsitesModule } from "../websites/interfaces";
import type { AnalyticsModule, TrafficSummary } from "./interfaces";
import { createAnalyticsRoutes } from "./routes";
import { AnalyticsIngestService } from "./services/analytics-ingest.service";
import { AnalyticsQueryService } from "./services/analytics-query.service";
import { AnalyticsPageviewUrlService } from "./services/pageview-urls.service";
import { AnalyticsEventFeedService } from "./services/raw-events.service";
import { PublicDashboardService } from "./services/public-dashboard.service";
import { AnalyticsRetentionPurge } from "./services/retention-purge.service";
import { AnalyticsTrafficSummaryService } from "./services/traffic-summary.service";
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
  const reads = new AnalyticsQueryService(websitesModule.query);
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
      analytics: reads,
      publicDashboard,
      // Access checks read through the uncached view on purpose — see `WebsitesModule`.
      websites: websitesModule.accessChecks,
      cfg: deps.cfg,
    }),
  };
}
