import type { Context } from "hono";
import { parseQuery } from "../../../platform/validation";
import { funnelsActiveQuerySchema } from "../validators/funnel.schema";
import type { FunnelControllerDeps } from "./funnel-controller.types";

export function getActiveFunnels(deps: FunnelControllerDeps) {
  return async (c: Context) => {
    const query = parseQuery(c, funnelsActiveQuerySchema);
    if (!query.ok) return query.res;
    const websiteRef = query.data.website_id ?? query.data.websiteId;
    if (!websiteRef) return c.json({ error: "website_id required" }, 400);
    const website = await deps.websites.getById(websiteRef);
    if (!website || !website.isActive) return c.json({ data: [] });
    return c.json({ data: await deps.trackerConfig.activeForTracker(website.id) });
  };
}
