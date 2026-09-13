import { Hono } from "hono";
import { evaluateTrackerAutomation } from "./controllers/tracker-automation.controller";
import { collectTracker } from "./controllers/tracker-collect.controller";
import { getTrackerConfig, initTracker } from "./controllers/tracker-config.controller";
import type { TrackerControllerDeps } from "./controllers/tracker-controller.types";
import { requestTrackerScreenshot } from "./controllers/tracker-screenshot.controller";

export function createTrackerRoutes(deps: TrackerControllerDeps) {
  const routes = new Hono();

  routes.get("/init/:website_id", initTracker(deps));
  routes.get("/config/:website_id", getTrackerConfig(deps));
  routes.post("/collect", collectTracker(deps));
  routes.post("/request-screenshot", requestTrackerScreenshot(deps));
  routes.post("/automations/evaluate", evaluateTrackerAutomation(deps));

  return routes;
}
