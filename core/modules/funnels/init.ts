import type { AnalyticsModule } from "../analytics/interfaces";
import type { WebsitesModule } from "../websites/interfaces";
import type { FunnelsModule } from "./interfaces";
import { FunnelUsageCounter } from "./services/usage-count.service";
import { createFunnelRoutes } from "./routes";
import { FunnelDefinitionService } from "./services/funnel-definition.service";
import { FunnelPerformanceService } from "./services/funnel-performance.service";
import { TrackerFunnelConfigService } from "./services/tracker-funnel-config.service";

/** Build the funnels module. */
export function initFunnelsModule(deps: {
  websitesModule: WebsitesModule;
  /** Funnel step counts are an `analytics_events` aggregation. */
  analyticsModule: AnalyticsModule;
}): FunnelsModule {
  const definitions = new FunnelDefinitionService();
  const performance = new FunnelPerformanceService(deps.analyticsModule.funnelEvents);
  const trackerConfig = new TrackerFunnelConfigService();

  return {
    trackerConfig,
    usage: new FunnelUsageCounter(),
    routes: createFunnelRoutes({
      definitions,
      performance,
      trackerConfig,
      websites: deps.websitesModule.accessChecks,
    }),
  };
}
