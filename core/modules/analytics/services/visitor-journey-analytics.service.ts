import type { AnalyticsBehaviour, AnalyticsQueryParams } from "../interfaces";
import { getActivityTrendsStats } from "../repositories/activity-trends.repository";
import { getCustomEventsAnalytics } from "../repositories/custom-events.repository";
import { getPathAnalysisAnalytics } from "../repositories/path-analysis.repository";
import { getVisitorInsightsAnalytics } from "../repositories/visitor-insights.repository";

export type VisitorJourneyAnalyticsQueries = {
  getActivityTrendsStats: typeof getActivityTrendsStats;
  getPathAnalysisAnalytics: typeof getPathAnalysisAnalytics;
  getVisitorInsightsAnalytics: typeof getVisitorInsightsAnalytics;
  getCustomEventsAnalytics: typeof getCustomEventsAnalytics;
};

const defaultQueries: VisitorJourneyAnalyticsQueries = {
  getActivityTrendsStats,
  getPathAnalysisAnalytics,
  getVisitorInsightsAnalytics,
  getCustomEventsAnalytics,
};

export class VisitorJourneyAnalyticsService
  implements AnalyticsBehaviour
{
  private readonly queries: VisitorJourneyAnalyticsQueries;

  constructor(queries: Partial<VisitorJourneyAnalyticsQueries> = {}) {
    this.queries = { ...defaultQueries, ...queries };
  }

  private async read(
    websiteId: string,
    query: AnalyticsQueryParams,
    operation: (id: string, q: AnalyticsQueryParams) => Promise<unknown>,
  ): Promise<unknown> {
    return operation(websiteId, query);
  }

  getActivityTrends(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getActivityTrendsStats); }
  getPathAnalysis(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getPathAnalysisAnalytics); }
  getVisitorInsights(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getVisitorInsightsAnalytics); }
  getCustomEvents(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getCustomEventsAnalytics); }
}
