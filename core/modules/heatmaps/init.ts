import { heatmapsLane } from "./ingest-lane";
import type { AnalyticsModule } from "../analytics/interfaces";
import type { WebsitesModule } from "../websites/interfaces";
import type { HeatmapsModule } from "./interfaces";
import { HeatmapUsageCounter } from "./services/usage-count.service";
import { createHeatmapRoutes } from "./routes";
import { HeatmapRawReadService } from "./services/heatmap-raw-read.service";
import { HeatmapAutoCapture } from "./services/heatmap-auto-capture.service";
import { heatmapIngestService, createHeatmapIngestService } from "./services/heatmap-ingest.service";
import { HeatmapMutationService } from "./services/heatmap-mutation.service";
import { HeatmapQueryService } from "./services/heatmap-query.service";
import { HeatmapRetentionPurge } from "./services/retention-purge.service";
import { initializeScreenshotCache } from "./services/screenshot-cache.service";
import { HeatmapScreenshotRefreshService } from "./services/heatmap-screenshot-refresh.service";
import { HeatmapScreenshotService } from "./services/playwright-screenshot-capture.service";
import { HeatmapSettingsService } from "./services/heatmap-capture-settings.service";
import { shutdownScreenshotBrowser } from "./lib/playwright-screenshots";

/**
 * Build the heatmaps module.
 *
 * The five-class order below is forced by the dependency arrows and is nobody else's
 * business: `autoCapture` needs a capture function, and both `HeatmapService` and the
 * refresh service need `autoCapture`, so the playwright-screenshot-capture.service is built first and its
 * bound `captureForResolved` passed through — which is why that method is bound in its
 * constructor. This used to sit in the composition root, which meant the top-level app
 * file knew the name of a method on a class two layers inside this module.
 */
export function initHeatmapsModule(deps: {
  websitesModule: WebsitesModule;
  /** For the screenshot-target fallback: recent pageview URLs live in analytics. */
  analyticsModule: AnalyticsModule;
}): HeatmapsModule {

  const settings = new HeatmapSettingsService(deps.websitesModule.query);
  const screenshots = new HeatmapScreenshotService(settings);
  const autoCapture = new HeatmapAutoCapture(
    screenshots.captureForResolved,
    deps.analyticsModule.pageviewUrls,
  );
  const heatmapQueries = new HeatmapQueryService(settings, autoCapture);
  const heatmapMutations = new HeatmapMutationService();

  return {
    lane: heatmapsLane(() => heatmapIngestService()),

    screenshots,
    maintenance: new HeatmapScreenshotRefreshService(settings, autoCapture),
    ingest: () => heatmapIngestService(),
    retention: new HeatmapRetentionPurge(),
    usage: new HeatmapUsageCounter(),
    rawReads: new HeatmapRawReadService(),
    routes: createHeatmapRoutes({
      heatmapQueries,
      heatmapMutations,
      screenshots,
      websites: deps.websitesModule.accessChecks,
    }),

    start(cfg) {
      if (cfg.screenshotCache.enabled) {
        initializeScreenshotCache(cfg.screenshotCache.ttlMs, cfg.screenshotCache.maxEntries);
      }
      // The engine takes the bus, so it has to be built from the composed graph — an
      // engine created lazily on first ingest publishes to nobody. Here rather than
      // above because constructing it arms flush timers.
      createHeatmapIngestService(deps.websitesModule.trackerWebsites);
    },

    /**
     * Engine first, then the browser.
     *
     * The engine's drain can still trigger a capture, so closing Chromium before it has
     * finished would fail that capture rather than complete it. The browser close was
     * missing entirely — this module launches a child process on first capture and, for
     * a module that implements `ModuleLifecycle`, leaving it running is a shutdown that
     * has not finished.
     */
    async stop() {
      await heatmapIngestService().shutdown();
      await shutdownScreenshotBrowser();
    },
  };
}
