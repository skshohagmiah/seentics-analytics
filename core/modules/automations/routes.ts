import { Hono } from "hono";
import { authMiddleware, type AuthVars } from "../../platform/middleware/auth";
import type { AutomationControllerDeps } from "./controllers/automation-controller.types";
import {
  bulkDeleteAutomations,
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  updateAutomation,
} from "./controllers/automation-crud.controller";
import {
  getAutomationDailyStats,
  getAutomationStats,
  listAutomationExecutions,
  toggleAutomation,
} from "./controllers/automation-insights.controller";

export function createAutomationRoutes(deps: AutomationControllerDeps) {
  const routes = new Hono<{ Variables: AuthVars }>();
  routes.use("*", authMiddleware);
  routes.get("/:website_id", listAutomations(deps));
  routes.post("/:website_id", createAutomation(deps));
  routes.delete("/:website_id/bulk-delete", bulkDeleteAutomations(deps));
  routes.get("/:website_id/:id", getAutomation(deps));
  routes.put("/:website_id/:id", updateAutomation(deps));
  routes.delete("/:website_id/:id", deleteAutomation(deps));
  routes.get("/:website_id/:id/executions", listAutomationExecutions(deps));
  routes.post("/:website_id/:id/toggle", toggleAutomation(deps));
  routes.get("/:website_id/:id/stats", getAutomationStats(deps));
  routes.get("/:website_id/:id/stats/daily", getAutomationDailyStats(deps));
  return routes;
}
