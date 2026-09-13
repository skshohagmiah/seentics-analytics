import type { Context } from "hono";
import { analyticsQuery, analyticsRead } from "./analytics-access";
import type { AnalyticsControllerDeps } from "./analytics-controller.types";

export function getPublicDashboard(deps: AnalyticsControllerDeps) {
  return async (c: Context<any, "/public/dashboard/:public_id">) => {
    const data = await deps.publicDashboard.getPublicDashboard(
      c.req.param("public_id"),
      analyticsQuery(c),
    );
    return data ? c.json(data) : c.json({ error: "not found" }, 404);
  };
}

export const getDashboard = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dashboard.getDashboard(websiteRef, query));
export const getTrafficSummary = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dashboard.getTrafficSummary(websiteRef, query));
export const getDailyStats = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dashboard.getDailyStats(websiteRef, query));
export const getHourlyStats = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.dashboard.getHourlyStats(websiteRef, query));
export const getGoalsStats = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.conversions.getGoals(websiteRef, query));
export const getRevenue = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.conversions.getRevenueDashboard(websiteRef, query));
export const exportAnalytics = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.exporter.exportEvents(websiteRef, query));
