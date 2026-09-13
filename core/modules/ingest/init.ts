import { log as baseLog, type Logger } from "../../platform/lib/logger";
import type { AutomationsModule } from "../automations/interfaces";
import type { FunnelsModule } from "../funnels/interfaces";
import type { HeatmapsModule } from "../heatmaps/interfaces";
import type { WebsitesModule } from "../websites/interfaces";
import type { IngestModule, LaneRegistry } from "./interfaces";
import { createTrackerRoutes } from "./routes";
import { CollectBuffer } from "./services/collect-buffer.service";
import { BatchWorker } from "./services/batch-worker.service";
import { postgresBatchQueue } from "./repositories/postgres-batch-queue";

/**
 * Build the ingest module.
 *
 * The registry is the whole composition: each feature contributes one `LaneSpec` — how its
 * rows partition, how much of them to buffer, and how to write them — and ingest supplies
 * only the machinery that is genuinely generic. Adding a feature's ingest is one entry
 * here and one file in the owning module; removing one is deleting both.
 *
 * The two engines arrive as their modules' `ingest` getters rather than resolved objects.
 * Both arm flush timers and open storage clients on construction, so resolving them here
 * would mean merely building the graph started background work.
 */
export function initIngestModule(deps: {
  /**
   * Every lane, assembled by the composition root from the modules that own the data.
   *
   * Passed in rather than built here: a lane is a *value* from a peer module, and ingest
   * importing peers' code — rather than their interfaces — is the coupling this module
   * has spent three refactors removing.
   */
  registry: LaneRegistry;
  /** For the tracker `/init` and `/automations/evaluate` surfaces, not for ingest. */
  automationsModule: AutomationsModule;
  funnelsModule: FunnelsModule;
  /** For `/request-screenshot`. */
  heatmapsModule: HeatmapsModule;
  /** For its tracker-facing lookup — anonymous, heavily cached, not `WebsiteQuery`. */
  websitesModule: WebsitesModule;
  logger?: Logger;
}): IngestModule {
  const logger = deps.logger ?? baseLog;

  // The buffer enqueues; the worker applies. Splitting them is what puts a committed row
  // between the tracker request and the module writes, so a crash costs at most the
  // batches in flight rather than every in-memory buffer.
  const buffer = new CollectBuffer(deps.registry, postgresBatchQueue, logger);
  const worker = new BatchWorker(postgresBatchQueue, deps.registry, logger);

  return {
    queue: buffer,
    routes: createTrackerRoutes({
      queue: buffer,
      automations: deps.automationsModule.trackerSettings,
      automationEvaluation: deps.automationsModule.evaluation,
      funnels: deps.funnelsModule.trackerConfig,
      screenshots: deps.heatmapsModule.screenshots,
      trackerWebsites: deps.websitesModule.trackerWebsites,
    }),

    start(cfg) {
      buffer.configure(cfg);
      buffer.start();
      worker.start();
    },

    /**
     * Stop the timer, drain the buffers onto the queue, then drain the queue.
     *
     * All three, in that order. Stopping without `flushNow` loses whatever is still
     * buffered; enqueueing without draining leaves committed batches for the next boot to
     * pick up — survivable, but a clean shutdown should hand over an empty queue.
     *
     * The engines are shut down after this returns, by their own modules. Reversing the
     * two would discard whatever this drain just handed them.
     */
    async stop() {
      buffer.stop();
      await buffer.flushNow();
      await worker.stop();
      await worker.drainOnce();
    },
  };
}
