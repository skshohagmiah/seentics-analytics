import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseJson } from "../../../platform/validation";
import { readJsonBody, stringOrEmpty } from "../lib/request-body";
import { heatmapBulkDeleteSchema } from "../validators/heatmap.schema";
import { requireHeatmapAccess } from "./heatmap-access";
import type { HeatmapControllerDeps } from "./heatmap-controller.types";

export function saveHeatmapScreenshot(deps: HeatmapControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id/save-screenshot">) => {
    const websiteRef = c.req.param("website_id");
    const denied = await requireHeatmapAccess(c, deps, websiteRef);
    if (denied) return denied;
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.res;
    const pagePath = stringOrEmpty(parsed.body.page_path);
    const image = stringOrEmpty(parsed.body.image);
    if (!pagePath || !image) return c.json({ error: "page_path and image required" }, 400);
    try {
      await deps.heatmapMutations.saveDashboardScreenshot(
        websiteRef,
        pagePath,
        image,
        Number(parsed.body.doc_width ?? 0),
        Number(parsed.body.doc_height ?? 0),
      );
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: String(error) }, 400);
    }
  };
}

export function deleteHeatmapPages(deps: HeatmapControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/:website_id/bulk-delete">) => {
    const websiteRef = c.req.param("website_id");
    const denied = await requireHeatmapAccess(c, deps, websiteRef);
    if (denied) return denied;
    const parsed = await parseJson(c, heatmapBulkDeleteSchema);
    if (!parsed.ok) return parsed.res;
    await deps.heatmapMutations.bulkDeletePages(websiteRef, parsed.data.pagePaths);
    return c.body(null, 204);
  };
}
