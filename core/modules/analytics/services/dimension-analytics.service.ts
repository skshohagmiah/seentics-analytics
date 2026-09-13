import type { AnalyticsDimensions, AnalyticsQueryParams } from "../interfaces";
import { getCitiesAnalytics } from "../repositories/cities.repository";
import { getDimensionsBulkAnalytics } from "../repositories/dimensions-bulk.repository";
import {
  getBrowsersAnalytics,
  getCountriesAnalytics,
  getDevicesAnalytics,
  getOsAnalytics,
} from "../repositories/dimensions.repository";
import { getGeolocationAnalytics } from "../repositories/geolocation.repository";
import { getLanguagesAnalytics } from "../repositories/languages.repository";
import { getPageUtmBreakdownAnalytics } from "../repositories/page-utm-breakdown.repository";
import { getPagesAnalytics } from "../repositories/pages.repository";
import { getReferrersAnalytics } from "../repositories/referrers.repository";
import { getResolutionsAnalytics } from "../repositories/resolutions.repository";
import { getSourcesAnalytics } from "../repositories/sources.repository";

export type DimensionAnalyticsQueries = {
  getPagesAnalytics: typeof getPagesAnalytics;
  getReferrersAnalytics: typeof getReferrersAnalytics;
  getSourcesAnalytics: typeof getSourcesAnalytics;
  getBrowsersAnalytics: typeof getBrowsersAnalytics;
  getDevicesAnalytics: typeof getDevicesAnalytics;
  getOsAnalytics: typeof getOsAnalytics;
  getCountriesAnalytics: typeof getCountriesAnalytics;
  getCitiesAnalytics: typeof getCitiesAnalytics;
  getLanguagesAnalytics: typeof getLanguagesAnalytics;
  getResolutionsAnalytics: typeof getResolutionsAnalytics;
  getGeolocationAnalytics: typeof getGeolocationAnalytics;
  getPageUtmBreakdownAnalytics: typeof getPageUtmBreakdownAnalytics;
  getDimensionsBulkAnalytics: typeof getDimensionsBulkAnalytics;
};

const defaultQueries: DimensionAnalyticsQueries = {
  getPagesAnalytics,
  getReferrersAnalytics,
  getSourcesAnalytics,
  getBrowsersAnalytics,
  getDevicesAnalytics,
  getOsAnalytics,
  getCountriesAnalytics,
  getCitiesAnalytics,
  getLanguagesAnalytics,
  getResolutionsAnalytics,
  getGeolocationAnalytics,
  getPageUtmBreakdownAnalytics,
  getDimensionsBulkAnalytics,
};

export class DimensionAnalyticsService
  implements AnalyticsDimensions
{
  private readonly queries: DimensionAnalyticsQueries;

  constructor(queries: Partial<DimensionAnalyticsQueries> = {}) {
    this.queries = { ...defaultQueries, ...queries };
  }

  private async read(
    websiteId: string,
    query: AnalyticsQueryParams,
    operation: (id: string, q: AnalyticsQueryParams) => Promise<unknown>,
  ): Promise<unknown> {
    return operation(websiteId, query);
  }

  getPages(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getPagesAnalytics); }
  getReferrers(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getReferrersAnalytics); }
  getSources(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getSourcesAnalytics); }
  getBrowsers(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getBrowsersAnalytics); }
  getDevices(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getDevicesAnalytics); }
  getOperatingSystems(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getOsAnalytics); }
  getCountries(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getCountriesAnalytics); }
  getCities(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getCitiesAnalytics); }
  getLanguages(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getLanguagesAnalytics); }
  getResolutions(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getResolutionsAnalytics); }
  getGeolocation(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getGeolocationAnalytics); }
  getPageUtmBreakdown(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getPageUtmBreakdownAnalytics); }
  getDimensionsBulk(id: string, q: AnalyticsQueryParams) { return this.read(id, q, this.queries.getDimensionsBulkAnalytics); }
}
