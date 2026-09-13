import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseQuery } from "../../../platform/validation";
import {
  analyticsRealtimeGeoQuerySchema,
  analyticsRecentActivityQuerySchema,
} from "../validators/analytics.schema";
import { analyticsRead, requireAnalyticsAccess } from "./analytics-access";
import type { AnalyticsControllerDeps } from "./analytics-controller.types";

export const getRealtime = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef) => deps.realtime.getRealtime(websiteRef));
export const getLiveVisitors = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef) => deps.realtime.getLiveVisitors(websiteRef));

export function getRecentActivity(deps: AnalyticsControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/recent-activity/:website_id">) => {
    const websiteRef = c.req.param("website_id");
    const denied = await requireAnalyticsAccess(c, deps, websiteRef);
    if (denied) return denied;
    const query = parseQuery(c, analyticsRecentActivityQuerySchema);
    if (!query.ok) return query.res;
    const data = await deps.realtime.getRecentActivity(websiteRef, query.data.limit, {
      withinMinutes: query.data.within_minutes,
    });
    return c.json(data as object);
  };
}

export function getRealtimeGeo(deps: AnalyticsControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/realtime-geo/:website_id">) => {
    const websiteRef = c.req.param("website_id");
    const denied = await requireAnalyticsAccess(c, deps, websiteRef);
    if (denied) return denied;
    const query = parseQuery(c, analyticsRealtimeGeoQuerySchema);
    if (!query.ok) return query.res;
    const options = query.data.within_minutes != null
      ? { withinMinutes: query.data.within_minutes }
      : undefined;
    return c.json(await deps.realtime.getRealtimeGeo(websiteRef, options) as object);
  };
}
