import type { AppConfig } from "../config";
import { log, type Logger } from "../platform/lib/logger";
import { initMaxMindGeo } from "../platform/lib/maxmind-geo";
import { configureTrackerOriginCache } from "../platform/lib/origin";
import { createInternalRoutes } from "../platform/internal/routes";
import { RetentionService } from "../platform/retention";
import { UserUsageService } from "../platform/usage";
import { startScheduler, stopScheduler } from "../platform/scheduler";
import type { ModuleLifecycle } from "./module";
import { initAiModule } from "../modules/ai/init";
import { initAnalyticsModule } from "../modules/analytics/init";
import { initAuthModule } from "../modules/auth/init";
import { initAutomationsModule } from "../modules/automations/init";
import { initFunnelsModule } from "../modules/funnels/init";
import { initHeatmapsModule } from "../modules/heatmaps/init";
import { initIngestModule } from "../modules/ingest/init";
import { initRecordingsModule } from "../modules/recordings/init";
import { initWebsitesModule } from "../modules/websites/init";
import type { AiModule } from "../modules/ai/interfaces";
import type { AnalyticsModule } from "../modules/analytics/interfaces";
import type { AuthModule } from "../modules/auth/interfaces";
import type { AutomationsModule } from "../modules/automations/interfaces";
import type { FunnelsModule } from "../modules/funnels/interfaces";
import type { HeatmapsModule } from "../modules/heatmaps/interfaces";
import type { IngestModule } from "../modules/ingest/interfaces";
import type { RecordingsModule } from "../modules/recordings/interfaces";
import type { WebsitesModule } from "../modules/websites/interfaces";

/**
 * Everything the HTTP layer and the background workers need, wired once.
 *
 * Returned rather than stashed in a global so there is exactly one place that knows how
 * the graph fits together. Each module is built by its own `init.ts` and receives other
 * modules plus the event bus — nothing else. Handing a module its peers whole is safe
 * because every member of an `XModule` interface is itself an interface:
 * `websitesModule` in scope gives you `query`, `accessChecks`, `sharing` and
 * `invitations`, and no route into the Postgres repository, the cache, or a mutation.
 */
export type Application = {
  modules: {
    auth: AuthModule;
    websites: WebsitesModule;
    analytics: AnalyticsModule;
    recordings: RecordingsModule;
    funnels: FunnelsModule;
    heatmaps: HeatmapsModule;
    automations: AutomationsModule;
    ai: AiModule;
    ingest: IngestModule;
  };
  routes: {
    analytics: AnalyticsModule["routes"];
    recordings: RecordingsModule["routes"];
    funnels: FunnelsModule["routes"];
    tracker: IngestModule["routes"];
    websites: WebsitesModule["routes"];
    heatmaps: HeatmapsModule["routes"];
    automations: AutomationsModule["routes"];
    ai: AiModule["routes"];
    internal: ReturnType<typeof createInternalRoutes>;
  };

  /**
   * Initialise module state and begin background work.
   *
   * Call after the HTTP server is listening and migrations have run. Async because the
   * geo database is read from disk.
   */
  start(): Promise<void>;

  /** Stop background work, drain buffers, and shut the engines down in order. */
  stop(): Promise<void>;
};

/**
 * Compose the application graph.
 *
 * Reads top to bottom in dependency order. The one thing that does not fit that shape
 * is websites and analytics, which genuinely need each other — the website list embeds
 * pageview counts, and every analytics query resolves a website — so websites takes
 * `() => analyticsModule` and reads it when a request arrives, by which point both
 * exist.
 * That getter is the only piece of indirection in this file; everything else is a
 * module handed its dependencies directly.
 */
export function bootstrap(cfg: AppConfig, logger: Logger = log): Application {
  // ─── Infrastructure ──────────────────────────────────────────────────────

  // ─── Modules ─────────────────────────────────────────────────────────────
  // Auth first: it depends on nothing, and websites needs it to read member names.
  const authModule = initAuthModule();

  // Safe despite naming `analyticsModule` a line before it exists: the getter is not
  // called during construction, only while serving a request.
  const websitesModule = initWebsitesModule({
    analyticsModule: () => analyticsModule,
    authModule,
  });

  const analyticsModule = initAnalyticsModule({ websitesModule, cfg });
  const recordingsModule = initRecordingsModule({ websitesModule });
  const funnelsModule = initFunnelsModule({ websitesModule, analyticsModule });
  const heatmapsModule = initHeatmapsModule({ websitesModule, analyticsModule });
  const automationsModule = initAutomationsModule({ websitesModule });
  const aiModule = initAiModule({ websitesModule });

  // The lane registry is the composition: each module contributes the ingest for the data
  // it owns, and ingest supplies only the generic machinery. Adding a feature's ingest is
  // one lane here and one file in that module.
  const ingestModule = initIngestModule({
    registry: {
      analytics: analyticsModule.lanes.analytics,
      funnels: analyticsModule.lanes.funnels,
      automations: automationsModule.lanes.automations,
      profiles: automationsModule.lanes.profiles,
      recordings: recordingsModule.lane,
      heatmaps: heatmapsModule.lane,
    },
    automationsModule,
    funnelsModule,
    heatmapsModule,
    websitesModule,
  });

  // ─── Retention ───────────────────────────────────────────────────────────
  // Retention owns the policy; each module deletes its own rows through the
  // `RetentionPurge` it exposes. This array order is the order they run per website:
  // analytics and automations first because they are pure SQL, then the two that also
  // clear object storage and therefore take far longer.
  const retention = new RetentionService(websitesModule.retentionSites, [
    analyticsModule.retention,
    automationsModule.retention,
    recordingsModule.retention,
    heatmapsModule.retention,
  ]);

  // Keys stay bare here — the record is already called `modules`, so
  // `application.modules.analytics` reads better than `…modules.analyticsModule`.
  // ─── Usage ───────────────────────────────────────────────────────────────
  // Same inversion as retention: this layer owns the report shape and resolves the
  // user's websites once, then each module counts its own rows. The `key` on each
  // counter is the response field name, so this list defines the report body.
  const usage = new UserUsageService(websitesModule.query, [
    websitesModule.usage,
    funnelsModule.usage,
    automationsModule.usage,
    heatmapsModule.usage,
    recordingsModule.usage,
    analyticsModule.usage,
    aiModule.usage,
  ]);

  const modules = {
    auth: authModule,
    websites: websitesModule,
    analytics: analyticsModule,
    recordings: recordingsModule,
    funnels: funnelsModule,
    heatmaps: heatmapsModule,
    automations: automationsModule,
    ai: aiModule,
    ingest: ingestModule,
  };

  /**
   * The four modules with background work, in composition order.
   *
   * `start` walks it forward and `stop` walks it back, which makes shutdown ordering a
   * property of this list rather than something each module has to be told. It matters
   * in one place: ingest must drain into the recordings and heatmap engines before
   * those engines shut down, and ingest is composed after both.
   */
  const lifecycles: readonly [string, ModuleLifecycle][] = [
    ["websites", websitesModule],
    ["recordings", recordingsModule],
    ["heatmaps", heatmapsModule],
    ["ingest", ingestModule],
  ];

  return {
    modules,

    routes: {
      analytics: analyticsModule.routes,
      recordings: recordingsModule.routes,
      funnels: funnelsModule.routes,
      tracker: ingestModule.routes,
      websites: websitesModule.routes,
      heatmaps: heatmapsModule.routes,
      automations: automationsModule.routes,
      ai: aiModule.routes,
      // Reuses ingest's buffer: the internal collectors carry the same data over a
      // server-to-server API, so they get the same batching and exactly-once handling.
      internal: createInternalRoutes({
        queue: ingestModule.queue,
        retention,
        trackerWebsites: websitesModule.trackerWebsites,
        usage,
      }),
    },

    async start() {
      // Platform-wide initialisation that has to happen before traffic is served.
      // Module-owned setup lives in each module's own `start`.
      await initMaxMindGeo(cfg.maxmind);
      configureTrackerOriginCache(cfg);

      for (const [, mod] of lifecycles) {
        await mod.start?.(cfg);
      }

      startScheduler(cfg, { heatmapScreenshots: heatmapsModule.maintenance, retention });

      logger.info({ msg: "modules_started", modules: Object.keys(modules) });
    },

    async stop() {
      // Stop accepting scheduled work first, then unwind in reverse composition order —
      // which is what gets ingest's buffers drained into the two engines before either
      // engine shuts down.
      stopScheduler();

      for (const [name, mod] of [...lifecycles].reverse()) {
        try {
          await mod.stop?.();
        } catch (e) {
          // Logged, not rethrown: a module that will not stop must not prevent the
          // outbox from draining or the process from exiting.
          logger.error({ msg: `${name}_shutdown_error`, err: String(e) });
        }
      }

    },
  };
}
