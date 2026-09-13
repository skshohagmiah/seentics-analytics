import { normalizeHeatmapPagePath } from "../lib/paths";
import type { HeatmapMutations } from "../interfaces";
import { deleteHeatmaps } from "../repositories/heatmap-writes.repository";
import { decodeJpegUpload, storeDashboardScreenshot } from "./heatmap-layout-snapshot.service";

/** Dashboard-authenticated screenshot and deletion operations. */
export class HeatmapMutationService implements HeatmapMutations {
  async saveDashboardScreenshot(
    websiteId: string,
    pagePath: string,
    imageBase64: string,
    docWidth: number,
    docHeight: number,
  ): Promise<void> {
    const normalizedPath = normalizeHeatmapPagePath(pagePath);
    const jpeg = decodeJpegUpload(imageBase64);
    await storeDashboardScreenshot(websiteId, normalizedPath, jpeg, docWidth, docHeight);
  }

  async bulkDeletePages(websiteId: string, pagePaths: string[]): Promise<void> {
    await deleteHeatmaps(websiteId, pagePaths);
  }
}
