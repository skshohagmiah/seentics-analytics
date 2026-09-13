import { log as baseLog } from "../../../platform/lib/logger";
import { listStalePageSnapshots } from "../repositories/page-snapshots.repository";
import type { HeatmapScreenshotMaintenance, HeatmapSettings } from "../interfaces";
import type { HeatmapAutoCapture } from "./heatmap-auto-capture.service";

const log = baseLog.child({ category: "heatmap_screenshot" });

/** Default staleness threshold, matching the cron's three-day cadence. */
const DEFAULT_STALE_DAYS = 3;

/**
 * How many stale pages one tick may queue.
 *
 * Deliberately small: each one launches a headless browser, and a site with
 * thousands of stale pages would otherwise take the container down rather than
 * refresh gradually across ticks.
 */
const MAX_PER_RUN = 50;

/**
 * Scheduled re-capture of stale page snapshots.
 *
 * Split from `HeatmapScreenshotService` so the cron job holds only this: it picks
 * its targets from rows that already exist and cannot be asked to fetch an
 * arbitrary URL. Handing an unattended caller the general capture capability would
 * make it a much more attractive thing to compromise.
 */
export class HeatmapScreenshotRefreshService implements HeatmapScreenshotMaintenance {
  constructor(
    private readonly settings: HeatmapSettings,
    private readonly autoCapture: HeatmapAutoCapture,
  ) {}

  /**
   * Queue re-captures and return how many were scheduled.
   *
   * Captures run detached, so this counts work handed off rather than work
   * finished — a slow page must not stall the cron tick. Websites that no longer
   * exist are skipped: their snapshot rows outlive them until retention cleanup,
   * and re-capturing a deleted site's pages is pure waste.
   */
  async refreshStaleScreenshots(staleDays = DEFAULT_STALE_DAYS): Promise<{ queued: number }> {
    const staleCut = new Date(Date.now() - staleDays * 86_400_000);
    const stale = await listStalePageSnapshots(staleCut, MAX_PER_RUN);
    if (stale.length === 0) return { queued: 0 };

    log.info({
      msg: "heatmap_stale_refresh_batch",
      count: stale.length,
      stale_before: staleCut.toISOString(),
    });

    /**
     * One resolution per *website*, not per row.
     *
     * A stale batch is page snapshots, and a site with fifty stale pages produced fifty
     * identical lookups of the same website — the run was `MAX_PER_RUN` sequential queries
     * where the number of distinct sites is what actually bounds the work. Resolution is
     * also where the site URL to screenshot comes from, so it cannot simply be skipped.
     */
    const targets = new Map<string, Awaited<ReturnType<typeof this.settings.getCaptureTarget>>>();
    const resolve = async (websiteId: string) => {
      if (!targets.has(websiteId)) {
        targets.set(websiteId, await this.settings.getCaptureTarget(websiteId));
      }
      return targets.get(websiteId);
    };

    let queued = 0;
    for (const row of stale) {
      const target = await resolve(row.websiteId);
      if (!target) {
        log.warn({
          msg: "heatmap_stale_refresh_resolve_failed",
          website_id: row.websiteId,
          page_path: row.pagePath,
        });
        continue;
      }
      // `force` because the whole point is to replace an image whose content hash
      // still matches; without it the capture would short-circuit as a duplicate.
      this.autoCapture.schedule(target, row.pagePath, true);
      queued++;
    }

    return { queued };
  }
}
