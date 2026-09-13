import { Hono } from "hono";
import { authMiddleware, type AuthVars } from "../../platform/middleware/auth";
import {
  captureHeatmapScreenshot,
  captureHeatmapScreenshotBatch,
} from "./controllers/heatmap-capture.controller";
import type { HeatmapControllerDeps } from "./controllers/heatmap-controller.types";
import {
  deleteHeatmapPages,
  saveHeatmapScreenshot,
} from "./controllers/heatmap-mutation.controller";
import {
  getHeatmapData,
  getHeatmapLayoutSnapshot,
  listHeatmapPages,
} from "./controllers/heatmap-query.controller";

export function createHeatmapRoutes(deps: HeatmapControllerDeps) {
  const routes = new Hono<{ Variables: AuthVars }>();
  routes.use(authMiddleware);
  routes.get("/:website_id/pages", listHeatmapPages(deps));
  routes.get("/:website_id/data", getHeatmapData(deps));
  routes.get("/:website_id/layout-snapshot", getHeatmapLayoutSnapshot(deps));
  routes.post("/:website_id/save-screenshot", saveHeatmapScreenshot(deps));
  routes.delete("/:website_id/bulk-delete", deleteHeatmapPages(deps));
  routes.post("/:website_id/playwright-screenshot", captureHeatmapScreenshot(deps));
  routes.post(
    "/:website_id/playwright-batch-screenshots",
    captureHeatmapScreenshotBatch(deps),
  );
  return routes;
}
