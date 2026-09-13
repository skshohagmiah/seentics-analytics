import type { AnalyticsRealtime } from "../interfaces";
import { getLiveVisitorsStats } from "../repositories/live-visitors.repository";
import { getRealtimeGeoAnalytics } from "../repositories/realtime-geo.repository";
import { getRealtimeStats } from "../repositories/realtime.repository";
import { getRecentActivityAnalytics } from "../repositories/recent-activity.repository";

export type RealtimeAnalyticsQueries = {
  getRealtimeStats: typeof getRealtimeStats;
  getRealtimeGeoAnalytics: typeof getRealtimeGeoAnalytics;
  getLiveVisitorsStats: typeof getLiveVisitorsStats;
  getRecentActivityAnalytics: typeof getRecentActivityAnalytics;
};

const defaultQueries: RealtimeAnalyticsQueries = {
  getRealtimeStats,
  getRealtimeGeoAnalytics,
  getLiveVisitorsStats,
  getRecentActivityAnalytics,
};

export class RealtimeAnalyticsService
  implements AnalyticsRealtime
{
  private readonly queries: RealtimeAnalyticsQueries;

  constructor(queries: Partial<RealtimeAnalyticsQueries> = {}) {
    this.queries = { ...defaultQueries, ...queries };
  }

  async getRealtime(websiteId: string): Promise<unknown> {
    return this.queries.getRealtimeStats(websiteId);
  }

  async getRealtimeGeo(websiteId: string, opts?: { withinMinutes?: number }): Promise<unknown> {
    return this.queries.getRealtimeGeoAnalytics(websiteId, opts);
  }

  async getLiveVisitors(websiteId: string): Promise<unknown> {
    return this.queries.getLiveVisitorsStats(websiteId);
  }

  async getRecentActivity(
    websiteId: string,
    limit: number,
    opts?: { withinMinutes?: number },
  ): Promise<unknown> {
    return this.queries.getRecentActivityAnalytics(websiteId, limit, opts);
  }
}
