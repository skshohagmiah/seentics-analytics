import type { AnalyticsExport, AnalyticsQueryParams } from "../interfaces";
import { getExportAnalytics } from "../repositories/export.repository";

export class AnalyticsExportService
  implements AnalyticsExport
{
  constructor(
    private readonly exportQuery: typeof getExportAnalytics = getExportAnalytics,
  ) {}

  async exportEvents(websiteId: string, query: AnalyticsQueryParams): Promise<unknown> {
    return this.exportQuery(websiteId, query);
  }
}
