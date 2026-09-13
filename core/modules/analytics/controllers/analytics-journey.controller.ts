import { analyticsRead } from "./analytics-access";
import type { AnalyticsControllerDeps } from "./analytics-controller.types";

export const getActivityTrends = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.journeys.getActivityTrends(websiteRef, query));
export const getPathAnalysis = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.journeys.getPathAnalysis(websiteRef, query));
export const getVisitorInsights = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.journeys.getVisitorInsights(websiteRef, query));
export const getCustomEvents = (deps: AnalyticsControllerDeps) =>
  analyticsRead(deps, (websiteRef, query) => deps.journeys.getCustomEvents(websiteRef, query));
