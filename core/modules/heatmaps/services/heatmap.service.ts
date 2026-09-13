import { log as baseLog } from "../../../platform/lib/logger";
import { normalizeHeatmapPagePath } from "../lib/paths";
import type {
  HeatmapLayout,
  HeatmapMutations,
  HeatmapPageSummary,
  HeatmapPointOut,
  HeatmapQuery,
  HeatmapSettings,
  ResolvedWebsite,
} from "../interfaces";
import type { HeatmapAutoCapture } from "./auto-capture.service";
import {
  decodeJpegUpload,
  readLayoutSnapshot,
  storeDashboardScreenshot,
} from "./layout-snapshot.service";
import { getHeatmapPoints, listHeatmapPages } from "./page-query.service";
import { deleteHeatmaps } from "../repositories/heatmap-writes.repository";
import { coerceSnapshotDeviceBucket } from "../lib/device";

const log = baseLog.child({ category: "heatmap_screenshot" });

/**
 * The heatmaps read/write facade for the dashboard.
 *
 * Its structural job is the one `AnalyticsQueryService` and `RecordingService` do:
 * resolve a website reference exactly once per request — through the injected
 * `HeatmapSettings` port, which is itself backed by the websites module's
 * `WebsiteQuery` — and hand `ResolvedWebsite` to everything underneath. Each of
 * these operations used to call `resolveWebsiteIdsLenient` itself, so the heatmaps
 * module read the `websites` table directly and paid for the lookup again per call.
 *
 * That change is type-invisible: `websiteRef`, `websiteId` and `websiteId` are all
 * `string`, so nothing stops a caller passing the wrong one and getting an empty
 * result. What enforces it is that this class is the only caller of the read
 * functions and the repository — routes must not import from `../repositories`.
 */
export class HeatmapService implements HeatmapQuery, HeatmapMutations {
  constructor(
    private readonly settings: HeatmapSettings,
    private readonly autoCapture: HeatmapAutoCapture,
  ) {}

  /**
   * Resolve a website reference, tolerating an unknown one.
   *
   * Falls back to using the reference as both identifiers rather than throwing,
   * preserving the `lenientResolve: true` behaviour every one of these endpoints
   * already had. Heatmap rows can outlive the website row they were written under,
   * and failing the lookup would hide data the user can still legitimately list and
   * delete — leaving them unable to clean it up.
   *
   * Access is checked by the route before this runs, so an unresolvable reference
   * yields an empty result rather than exposing anything.
   */
  private async resolve(websiteRef: string): Promise<ResolvedWebsite> {
    const target = await this.settings.getCaptureTarget(websiteRef);
    if (target) return target;
    return { websiteId: websiteRef, siteUrl: "" };
  }

  async listPages(websiteRef: string): Promise<{ pages: HeatmapPageSummary[] }> {
    const { websiteId } = await this.resolve(websiteRef);
    return listHeatmapPages(websiteId);
  }

  async getPoints(
    websiteRef: string,
    pagePath: string,
    eventType: string,
  ): Promise<{ page_path: string; points: HeatmapPointOut[] }> {
    const { websiteId } = await this.resolve(websiteRef);
    return getHeatmapPoints(websiteId, pagePath, eventType);
  }

  async getLayoutSnapshot(
    websiteRef: string,
    pagePath: string,
    device?: string,
  ): Promise<{ layout: HeatmapLayout | null }> {
    const resolved = await this.resolve(websiteRef);
    const norm = normalizeHeatmapPagePath(pagePath);
    const bucket = coerceSnapshotDeviceBucket(device);
    const snapshot = await readLayoutSnapshot(resolved.websiteId, norm, bucket);

    if (snapshot.missing) {
      log.info({
        msg: "heatmap_snapshot_miss",
        website_uuid: resolved.websiteId,
        norm,
        device: bucket,
        triggering_autocapture: true,
      });
      // Detached: the dashboard renders the points without a backdrop and picks
      // the image up on a later poll.
      this.autoCapture.schedule(resolved, norm);
      return { layout: null };
    }

    if (snapshot.stale) {
      log.info({ msg: "heatmap_snapshot_stale_refresh", website_uuid: resolved.websiteId, norm });
      // Forced, because a stale image still matches its own content hash and
      // would otherwise be deduplicated away.
      this.autoCapture.schedule(resolved, norm, true);
    }

    return { layout: snapshot.layout };
  }

  /**
   * Store a screenshot the dashboard rendered itself.
   *
   * Bypasses the tracker `/collect` flow — an authenticated user on the heatmap
   * page triggers this directly, which is how a page nobody has visited since
   * layout capture was enabled gets a backdrop at all.
   *
   * The image is validated before the website is looked up, preserving the order
   * the endpoint has always reported errors in: a malformed upload is a malformed
   * upload regardless of whether the site still exists.
   */
  async saveDashboardScreenshot(
    websiteRef: string,
    pagePath: string,
    imageBase64: string,
    docWidth: number,
    docHeight: number,
  ): Promise<void> {
    const target = await this.settings.getCaptureTarget(websiteRef);
    const norm = normalizeHeatmapPagePath(pagePath);
    const jpeg = decodeJpegUpload(imageBase64);

    // Message preserved verbatim — the route returns `String(e)` to the client.
    if (!target) throw new Error("website not found");

    const s3Key = await storeDashboardScreenshot(target, norm, jpeg, docWidth, docHeight);

  }

  async bulkDeletePages(websiteRef: string, pagePaths: string[]): Promise<void> {
    const resolved = await this.resolve(websiteRef);
    await deleteHeatmaps(resolved.websiteId, pagePaths);

    // Published after the delete, never before: retention accounting and any
    // cache invalidation downstream must not act on a deletion that failed.
  }
}
