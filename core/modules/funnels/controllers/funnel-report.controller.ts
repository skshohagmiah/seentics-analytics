import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { funnelFailure, requireFunnelAccess } from "./funnel-access";
import type { FunnelControllerDeps } from "./funnel-controller.types";

export function getFunnelReport(deps: FunnelControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id/funnels/:funnel_id/stats">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireFunnelAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const daysParam = c.req.query("days");
    const days = daysParam === undefined ? undefined : Number(daysParam);
    try {
      const data = await deps.performance.report(websiteRef, c.req.param("funnel_id"), days);
      return data ? c.json({ data }) : c.json({ error: "not found" }, 404);
    } catch (error) {
      return funnelFailure(c, "report", websiteRef, error);
    }
  };
}
