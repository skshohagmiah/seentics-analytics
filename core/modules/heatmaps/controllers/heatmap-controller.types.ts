import type { WebsiteQuery } from "../../websites/interfaces";
import type { HeatmapMutations, HeatmapQuery, HeatmapScreenshotCapture } from "../interfaces";

export type HeatmapControllerDeps = {
  heatmapQueries: HeatmapQuery;
  heatmapMutations: HeatmapMutations;
  screenshots: HeatmapScreenshotCapture;
  websites: WebsiteQuery;
};
