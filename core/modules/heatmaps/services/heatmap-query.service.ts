import { log } from "../../../platform/lib/logger";
import { coerceSnapshotDeviceBucket } from "../lib/device";
import { normalizeHeatmapPagePath } from "../lib/paths";
import type {
  HeatmapLayout,
  HeatmapPageSummary,
  HeatmapPointOut,
  HeatmapQuery,
  HeatmapSettings,
} from "../interfaces";
import type { HeatmapAutoCapture } from "./heatmap-auto-capture.service";
import { readLayoutSnapshot } from "./heatmap-layout-snapshot.service";
import { getHeatmapPoints, listHeatmapPages } from "./heatmap-page-query.service";

/** Dashboard heatmap reads. Website access is checked by the controller. */
export class HeatmapQueryService implements HeatmapQuery {
  constructor(
    private readonly settings: HeatmapSettings,
    private readonly autoCapture: HeatmapAutoCapture,
  ) {}

  listPages(websiteId: string): Promise<{ pages: HeatmapPageSummary[] }> {
    return listHeatmapPages(websiteId);
  }

  getPoints(
    websiteId: string,
    pagePath: string,
    eventType: string,
  ): Promise<{ page_path: string; points: HeatmapPointOut[] }> {
    return getHeatmapPoints(websiteId, pagePath, eventType);
  }

  async getLayoutSnapshot(
    websiteId: string,
    pagePath: string,
    device?: string,
  ): Promise<{ layout: HeatmapLayout | null }> {
    const target = await this.settings.getCaptureTarget(websiteId);
    const resolved = target ?? { websiteId, siteUrl: "", layoutEnabled: false };
    const normalizedPath = normalizeHeatmapPagePath(pagePath);
    const deviceBucket = coerceSnapshotDeviceBucket(device);
    const snapshot = await readLayoutSnapshot(websiteId, normalizedPath, deviceBucket);
    if (snapshot.missing) {
      log.info({ msg: "heatmap_snapshot_miss", website_uuid: websiteId, normalizedPath, device: deviceBucket });
      if (target) this.autoCapture.schedule(resolved, normalizedPath);
      return { layout: null };
    }
    if (snapshot.stale && target) this.autoCapture.schedule(resolved, normalizedPath, true);
    return { layout: snapshot.layout };
  }
}
