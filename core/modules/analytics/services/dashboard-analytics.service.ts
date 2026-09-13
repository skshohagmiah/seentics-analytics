import type { AnalyticsDashboard, AnalyticsQueryParams } from "../interfaces";
import { getDailyStatsAnalytics } from "../repositories/daily-stats.repository";
import { getDashboardStats } from "../repositories/dashboard.repository";
import { getHourlyStatsAnalytics } from "../repositories/hourly-stats.repository";
import { getTrafficSummaryStats } from "../repositories/traffic-summary.repository";

export type DashboardAnalyticsQueries = {
  getDashboardStats: typeof getDashboardStats;
  getTrafficSummaryStats: typeof getTrafficSummaryStats;
  getDailyStatsAnalytics: typeof getDailyStatsAnalytics;
  getHourlyStatsAnalytics: typeof getHourlyStatsAnalytics;
};

const defaultQueries: DashboardAnalyticsQueries = {
  getDashboardStats,
  getTrafficSummaryStats,
  getDailyStatsAnalytics,
  getHourlyStatsAnalytics,
};

export class DashboardAnalyticsService
  implements AnalyticsDashboard
{
  private readonly queries: DashboardAnalyticsQueries;

  constructor(queries: Partial<DashboardAnalyticsQueries> = {}) {
    this.queries = { ...defaultQueries, ...queries };
  }

  async getDashboard(websiteId: string, query: AnalyticsQueryParams): Promise<unknown> {
    return this.queries.getDashboardStats(websiteId, query);
  }

  async getTrafficSummary(websiteId: string, query: AnalyticsQueryParams): Promise<unknown> {
    return this.queries.getTrafficSummaryStats(websiteId, query);
  }

  async getDailyStats(websiteId: string, query: AnalyticsQueryParams): Promise<unknown> {
    return this.queries.getDailyStatsAnalytics(websiteId, query);
  }

  async getHourlyStats(websiteId: string, query: AnalyticsQueryParams): Promise<unknown> {
    return this.queries.getHourlyStatsAnalytics(websiteId, query);
  }
}
