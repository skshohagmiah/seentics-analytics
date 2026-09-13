import { Hono } from "hono";
import { authMiddleware, type AuthVars } from "../../platform/middleware/auth";
import { analyticsCacheMiddleware, PUBLIC_IDENTITY } from "./middleware/analytics-cache";
import type { AnalyticsControllerDeps } from "./controllers/analytics-controller.types";
import {
  exportAnalytics,
  getDailyStats,
  getDashboard,
  getGoalsStats,
  getHourlyStats,
  getPublicDashboard,
  getRevenue,
  getTrafficSummary,
} from "./controllers/analytics-dashboard.controller";
import * as dimensions from "./controllers/analytics-dimensions.controller";
import { importAnalytics } from "./controllers/analytics-import.controller";
import * as journey from "./controllers/analytics-journey.controller";
import {
  getLiveVisitors,
  getRealtime,
  getRealtimeGeo,
  getRecentActivity,
} from "./controllers/analytics-realtime.controller";

export function createAnalyticsRoutes(deps: AnalyticsControllerDeps) {
  const routes = new Hono<{ Variables: AuthVars }>();
  routes.get(
    "/public/dashboard/:public_id",
    analyticsCacheMiddleware(deps.cfg, PUBLIC_IDENTITY),
    getPublicDashboard(deps),
  );
  routes.use("*", authMiddleware);
  routes.use("*", analyticsCacheMiddleware(deps.cfg, (c) => c.get("userId") ?? null));
  routes.get("/dashboard/:website_id", getDashboard(deps));
  routes.get("/traffic-summary/:website_id", getTrafficSummary(deps));
  routes.get("/daily-stats/:website_id", getDailyStats(deps));
  routes.get("/hourly-stats/:website_id", getHourlyStats(deps));
  routes.get("/top-pages/:website_id", dimensions.getTopPages(deps));
  routes.get("/top-referrers/:website_id", dimensions.getTopReferrers(deps));
  routes.get("/top-sources/:website_id", dimensions.getTopSources(deps));
  routes.get("/top-browsers/:website_id", dimensions.getTopBrowsers(deps));
  routes.get("/top-devices/:website_id", dimensions.getTopDevices(deps));
  routes.get("/top-os/:website_id", dimensions.getTopOperatingSystems(deps));
  routes.get("/top-countries/:website_id", dimensions.getTopCountries(deps));
  routes.get("/top-cities/:website_id", dimensions.getTopCities(deps));
  routes.get("/top-languages/:website_id", dimensions.getTopLanguages(deps));
  routes.get("/top-resolutions/:website_id", dimensions.getTopResolutions(deps));
  routes.get("/geolocation-breakdown/:website_id", dimensions.getGeolocationBreakdown(deps));
  routes.get("/page-utm-breakdown/:website_id", dimensions.getPageUtmBreakdown(deps));
  routes.get("/dimensions-bulk/:website_id", dimensions.getDimensionsBulk(deps));
  routes.get("/activity-trends/:website_id", journey.getActivityTrends(deps));
  routes.get("/path-analysis/:website_id", journey.getPathAnalysis(deps));
  routes.get("/visitor-insights/:website_id", journey.getVisitorInsights(deps));
  routes.get("/custom-events/:website_id", journey.getCustomEvents(deps));
  routes.get("/goals-stats/:website_id", getGoalsStats(deps));
  routes.get("/revenue/:website_id", getRevenue(deps));
  routes.get("/export/:website_id", exportAnalytics(deps));
  routes.get("/realtime/:website_id", getRealtime(deps));
  routes.get("/live-visitors/:website_id", getLiveVisitors(deps));
  routes.get("/recent-activity/:website_id", getRecentActivity(deps));
  routes.get("/realtime-geo/:website_id", getRealtimeGeo(deps));
  routes.post("/import", importAnalytics());
  return routes;
}
