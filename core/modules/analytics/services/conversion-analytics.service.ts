import type { AnalyticsGoals, AnalyticsQueryParams, AnalyticsRevenue } from "../interfaces";
import { getGoalsStats } from "../repositories/goals.repository";
import { getRevenueDashboard } from "../repositories/revenue.repository";

export type ConversionAnalyticsQueries = {
  getGoalsStats: typeof getGoalsStats;
  getRevenueDashboard: typeof getRevenueDashboard;
};

const defaultQueries: ConversionAnalyticsQueries = { getGoalsStats, getRevenueDashboard };

export class ConversionAnalyticsService
  implements AnalyticsGoals, AnalyticsRevenue
{
  private readonly queries: ConversionAnalyticsQueries;

  constructor(queries: Partial<ConversionAnalyticsQueries> = {}) {
    this.queries = { ...defaultQueries, ...queries };
  }

  async getGoals(websiteId: string, query: AnalyticsQueryParams): Promise<unknown> {
    return this.queries.getGoalsStats(websiteId, query);
  }

  async getRevenueDashboard(websiteId: string, query: AnalyticsQueryParams): Promise<unknown> {
    return this.queries.getRevenueDashboard(websiteId, query);
  }
}
