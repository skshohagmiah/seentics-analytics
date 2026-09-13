import type { AppConfig } from "../../config";
import { log as baseLog } from "../lib/logger";
import type {
  RetentionCutoffs,
  RetentionPurge,
  RetentionSiteSource,
  RetentionTarget,
} from "./interfaces";
import { fetchRetentionOverrides, type WebsiteRetentionOverride } from "./overrides";

const log = baseLog.child({ category: "retention" });

/**
 * Counts from one sweep.
 *
 * `websitesProcessed` is retention's own; every other key comes verbatim from a
 * module's `purge` result, which is why this is an open record rather than a fixed
 * shape — a module can report a new metric without retention changing.
 */
export type DataCleanupStats = { websitesProcessed: number } & Record<string, number>;

type EffectivePolicy = {
  analyticsDays: number;
  replayDays: number;
  heatmapDays: number;
  funnelAutomationDays: number;
};

/** Per-website overrides win over the deployment default, field by field. */
function mergePolicy(
  base: AppConfig["dataRetention"],
  websiteId: string,
  overrides: Map<string, WebsiteRetentionOverride>,
): EffectivePolicy {
  const o = overrides.get(websiteId);
  return {
    analyticsDays: typeof o?.analytics_days === "number" ? o.analytics_days : base.analyticsDays,
    replayDays: typeof o?.replay_days === "number" ? o.replay_days : base.replayDays,
    heatmapDays: typeof o?.heatmap_days === "number" ? o.heatmap_days : base.heatmapDays,
    funnelAutomationDays:
      typeof o?.funnel_automation_days === "number"
        ? o.funnel_automation_days
        : base.funnelAutomationDays,
  };
}

function cutoffsFrom(policy: EffectivePolicy, now: number): RetentionCutoffs {
  return {
    analytics: new Date(now - policy.analyticsDays * 86_400_000),
    funnelAutomation: new Date(now - policy.funnelAutomationDays * 86_400_000),
    replay: new Date(now - policy.replayDays * 86_400_000),
    heatmap: new Date(now - policy.heatmapDays * 86_400_000),
  };
}

/**
 * The daily data-retention sweep.
 *
 * Owns the *policy* — how long each kind of data lives, including per-website
 * overrides — and nothing about how any of it is stored. Each module deletes its own
 * rows through `RetentionPurge`, which is what stopped this file from issuing DELETEs
 * against five tables belonging to four modules that had no idea it existed.
 *
 * Single-flight: the cron and the manual `/internal` trigger can both fire, and two
 * concurrent sweeps would race on the same batches.
 */
export class RetentionService {
  private inFlight = false;

  constructor(
    /** Where the site list comes from. Websites owns that table; this reads it. */
    private readonly sites: RetentionSiteSource,
    private readonly purgers: readonly RetentionPurge[],
  ) {}

  /**
   * Run a sweep, or return `null` if retention is disabled or one is already running.
   *
   * Returning `null` rather than throwing for the already-running case: a manual
   * trigger arriving during the nightly run is expected, not an error.
   */
  async runSafely(cfg: AppConfig): Promise<DataCleanupStats | null> {
    if (!cfg.dataRetention.enabled) return null;

    if (this.inFlight) {
      log.warn({ msg: "retention_already_running" });
      return null;
    }

    this.inFlight = true;
    try {
      const started = Date.now();
      const stats = await this.run(cfg);
      log.info({ msg: "retention_cleanup_done", ms: Date.now() - started, ...stats });
      return stats;
    } catch (e) {
      log.error({ msg: "retention_cleanup_failed", err: String(e) });
      throw e;
    } finally {
      this.inFlight = false;
    }
  }

  /** Sweep every website. Prefer `runSafely` — this has no concurrency guard. */
  async run(cfg: AppConfig): Promise<DataCleanupStats> {
    const stats: DataCleanupStats = { websitesProcessed: 0 };
    if (!cfg.dataRetention.enabled) return stats;

    const overrides = await fetchRetentionOverrides(cfg);

    const sites = await this.sites.listAllSites();

    const options = {
      // Clamped: too small multiplies round trips, too large holds a transaction open
      // across thousands of object-storage deletes.
      batchSize: Math.max(50, Math.min(2000, cfg.dataRetention.replayDeleteBatchSize)),
      bucket: cfg.s3.bucket,
      heatmapBucket: cfg.s3.heatmapBucket,
    };

    for (const target of sites) {
      const cutoffs = cutoffsFrom(
        mergePolicy(cfg.dataRetention, target.websiteId, overrides),
        Date.now(),
      );

      for (const purger of this.purgers) {
        try {
          const counts = await purger.purge(target, cutoffs, options);
          for (const [metric, n] of Object.entries(counts)) {
            stats[metric] = (stats[metric] ?? 0) + n;
          }
        } catch (e) {
          // One module failing for one website must not abandon the rest of the sweep
          // — including the other modules for this same website.
          log.error({
            msg: "retention_purge_failed",
            purger: purger.name,
            website_id: target.websiteId,
            err: String(e),
          });
        }
      }

      stats.websitesProcessed += 1;
    }

    return stats;
  }
}
