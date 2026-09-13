import { Hono } from "hono";
import { authMiddleware, type AuthVars } from "../../platform/middleware/auth";
import { deleteRecordings } from "./controllers/recording-delete.controller";
import { getRecording } from "./controllers/recording-detail.controller";
import { listRecordings } from "./controllers/recording-list.controller";
import type { RecordingControllerDeps } from "./controllers/recording-controller.types";

export function createRecordingRoutes(deps: RecordingControllerDeps) {
  const routes = new Hono<{ Variables: AuthVars }>();
  routes.use(authMiddleware);
  routes.get("/:website_id", listRecordings(deps));
  routes.delete("/:website_id/batch", deleteRecordings(deps));
  routes.get("/:website_id/:session_id", getRecording(deps));
  return routes;
}
