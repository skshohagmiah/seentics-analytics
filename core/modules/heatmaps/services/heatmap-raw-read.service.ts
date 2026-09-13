import type { HeatmapPageSummary, HeatmapPointOut, HeatmapRawReads } from "../interfaces";
import { getHeatmapPointsRaw, listHeatmapPages } from "./heatmap-page-query.service";

/** `HeatmapRawReads` over this module's existing page-query functions. */
export class HeatmapRawReadService implements HeatmapRawReads {
  async listPagesRaw(websiteId: string): Promise<{ pages: HeatmapPageSummary[] }> {
    return listHeatmapPages(websiteId);
  }

  async getPointsRaw(
    websiteId: string,
    pagePath: string,
    eventType: string,
  ): Promise<{ page_path: string; event_type: string; points: HeatmapPointOut[] }> {
    return getHeatmapPointsRaw(websiteId, pagePath, eventType);
  }
}
