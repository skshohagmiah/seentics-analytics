import type {
  AnalyticsBehaviour,
  AnalyticsDashboard,
  AnalyticsDimensions,
  AnalyticsExport,
  AnalyticsGoals,
  AnalyticsQueryParams,
  AnalyticsReads,
  AnalyticsRealtime,
  AnalyticsRevenue,
} from "../interfaces";

/**
 * Compatibility surface for the raw public API, which exposes every analytics read.
 * Domain controllers receive the individual services instead of this facade.
 */
export class AnalyticsReadFacade implements AnalyticsReads {
  constructor(
    private readonly dashboard: AnalyticsDashboard,
    private readonly dimensions: AnalyticsDimensions,
    private readonly realtime: AnalyticsRealtime,
    private readonly journeys: AnalyticsBehaviour,
    private readonly conversions: AnalyticsGoals & AnalyticsRevenue,
    private readonly exporter: AnalyticsExport,
  ) {}

  getDashboard(id: string, q: AnalyticsQueryParams) { return this.dashboard.getDashboard(id, q); }
  getTrafficSummary(id: string, q: AnalyticsQueryParams) { return this.dashboard.getTrafficSummary(id, q); }
  getDailyStats(id: string, q: AnalyticsQueryParams) { return this.dashboard.getDailyStats(id, q); }
  getHourlyStats(id: string, q: AnalyticsQueryParams) { return this.dashboard.getHourlyStats(id, q); }
  getPages(id: string, q: AnalyticsQueryParams) { return this.dimensions.getPages(id, q); }
  getReferrers(id: string, q: AnalyticsQueryParams) { return this.dimensions.getReferrers(id, q); }
  getSources(id: string, q: AnalyticsQueryParams) { return this.dimensions.getSources(id, q); }
  getBrowsers(id: string, q: AnalyticsQueryParams) { return this.dimensions.getBrowsers(id, q); }
  getDevices(id: string, q: AnalyticsQueryParams) { return this.dimensions.getDevices(id, q); }
  getOperatingSystems(id: string, q: AnalyticsQueryParams) { return this.dimensions.getOperatingSystems(id, q); }
  getCountries(id: string, q: AnalyticsQueryParams) { return this.dimensions.getCountries(id, q); }
  getCities(id: string, q: AnalyticsQueryParams) { return this.dimensions.getCities(id, q); }
  getLanguages(id: string, q: AnalyticsQueryParams) { return this.dimensions.getLanguages(id, q); }
  getResolutions(id: string, q: AnalyticsQueryParams) { return this.dimensions.getResolutions(id, q); }
  getGeolocation(id: string, q: AnalyticsQueryParams) { return this.dimensions.getGeolocation(id, q); }
  getPageUtmBreakdown(id: string, q: AnalyticsQueryParams) { return this.dimensions.getPageUtmBreakdown(id, q); }
  getDimensionsBulk(id: string, q: AnalyticsQueryParams) { return this.dimensions.getDimensionsBulk(id, q); }
  getRealtime(id: string) { return this.realtime.getRealtime(id); }
  getRealtimeGeo(id: string, opts?: { withinMinutes?: number }) { return this.realtime.getRealtimeGeo(id, opts); }
  getLiveVisitors(id: string) { return this.realtime.getLiveVisitors(id); }
  getRecentActivity(id: string, limit: number, opts?: { withinMinutes?: number }) {
    return this.realtime.getRecentActivity(id, limit, opts);
  }
  getActivityTrends(id: string, q: AnalyticsQueryParams) { return this.journeys.getActivityTrends(id, q); }
  getPathAnalysis(id: string, q: AnalyticsQueryParams) { return this.journeys.getPathAnalysis(id, q); }
  getVisitorInsights(id: string, q: AnalyticsQueryParams) { return this.journeys.getVisitorInsights(id, q); }
  getCustomEvents(id: string, q: AnalyticsQueryParams) { return this.journeys.getCustomEvents(id, q); }
  getGoals(id: string, q: AnalyticsQueryParams) { return this.conversions.getGoals(id, q); }
  getRevenueDashboard(id: string, q: AnalyticsQueryParams) { return this.conversions.getRevenueDashboard(id, q); }
  exportEvents(id: string, q: AnalyticsQueryParams) { return this.exporter.exportEvents(id, q); }
}
