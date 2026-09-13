import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireUser, type AuthVars } from "../../../platform/middleware/auth";
import type { HeatmapControllerDeps } from "./heatmap-controller.types";

export async function requireHeatmapAccess(
  c: Context<{ Variables: AuthVars }>,
  deps: HeatmapControllerDeps,
  websiteRef: string,
): Promise<Response | null> {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: "forbidden" }, 403);
  if (!(await deps.websites.getRole(websiteRef, userId))) {
    return c.json({ error: "forbidden" }, 403 as ContentfulStatusCode);
  }
  return null;
}
