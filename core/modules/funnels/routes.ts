import { Hono } from "hono";
import { authMiddleware, type AuthVars } from "../../platform/middleware/auth";
import type { FunnelControllerDeps } from "./controllers/funnel-controller.types";
import {
  bulkDeleteFunnels,
  createFunnel,
  deleteFunnel,
  getFunnel,
  listFunnels,
  updateFunnel,
} from "./controllers/funnel-crud.controller";
import { getFunnelReport } from "./controllers/funnel-report.controller";
import { getActiveFunnels } from "./controllers/funnel-tracker.controller";

export function createFunnelRoutes(deps: FunnelControllerDeps) {
  const publicRoutes = new Hono<{ Variables: AuthVars }>();
  publicRoutes.get("/active", getActiveFunnels(deps));

  const authRoutes = new Hono<{ Variables: AuthVars }>();
  authRoutes.use("*", authMiddleware);
  authRoutes.get("/:website_id/funnels", listFunnels(deps));
  authRoutes.post("/:website_id/funnels", createFunnel(deps));
  authRoutes.delete("/:website_id/funnels/bulk-delete", bulkDeleteFunnels(deps));
  authRoutes.get("/:website_id/funnels/:funnel_id", getFunnel(deps));
  authRoutes.put("/:website_id/funnels/:funnel_id", updateFunnel(deps));
  authRoutes.delete("/:website_id/funnels/:funnel_id", deleteFunnel(deps));
  authRoutes.get("/:website_id/funnels/:funnel_id/stats", getFunnelReport(deps));
  return { publicRoutes, authRoutes };
}
