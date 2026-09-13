import type { AppConfig } from "../../../config";
import type { WebsiteQuery } from "../../websites/interfaces";
import type {
  AnalyticsBehaviour,
  AnalyticsDashboard,
  AnalyticsDimensions,
  AnalyticsExport,
  AnalyticsGoals,
  AnalyticsPublicDashboard,
  AnalyticsRealtime,
  AnalyticsRevenue,
} from "../interfaces";

export type AnalyticsControllerDeps = {
  dashboard: AnalyticsDashboard;
  dimensions: AnalyticsDimensions;
  realtime: AnalyticsRealtime;
  journeys: AnalyticsBehaviour;
  conversions: AnalyticsGoals & AnalyticsRevenue;
  exporter: AnalyticsExport;
  publicDashboard: AnalyticsPublicDashboard;
  websites: WebsiteQuery;
  cfg: AppConfig;
};
