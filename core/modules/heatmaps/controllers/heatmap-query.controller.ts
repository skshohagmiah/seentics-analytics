import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseQuery } from "../../../platform/validation";
import { heatmapDataQuerySchema, heatmapSnapshotQuerySchema } from "../validators/heatmap.schema";
import { requireHeatmapAccess } from "./heatmap-access";
import type { HeatmapControllerDeps } from "./heatmap-controller.types";

export function listHeatmapPages(deps: HeatmapControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id/pages">) => {
    const websiteRef = c.req.param("website_id");
    const denied = await requireHeatmapAccess(c, deps, websiteRef);
    if (denied) return denied;
    return c.json(await deps.heatmapQueries.listPages(websiteRef));
  };
}

export function getHeatmapData(deps: HeatmapControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id/data">) => {
    const websiteRef = c.req.param("website_id");
    const denied = await requireHeatmapAccess(c, deps, websiteRef);
    if (denied) return denied;
    const query = parseQuery(c, heatmapDataQuerySchema);
    if (!query.ok) return query.res;
    return c.json(await deps.heatmapQueries.getPoints(
      websiteRef,
      query.data.page_path,
      query.data.event_type || "click",
    ));
  };
}

export function getHeatmapLayoutSnapshot(deps: HeatmapControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id/layout-snapshot">) => {
    const websiteRef = c.req.param("website_id");
    const denied = await requireHeatmapAccess(c, deps, websiteRef);
    if (denied) return denied;
    const query = parseQuery(c, heatmapSnapshotQuerySchema);
    if (!query.ok) return query.res;
    return c.json(await deps.heatmapQueries.getLayoutSnapshot(
      websiteRef,
      query.data.page_path,
      query.data.device,
    ));
  };
}
