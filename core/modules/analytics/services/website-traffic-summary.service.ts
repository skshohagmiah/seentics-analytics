import { and, gte, inArray, sql } from "drizzle-orm";
import { analyticsEvents, db } from "../../../db";
import type { TrafficSummary } from "../interfaces";

/** Window the dashboard summarises over. */
const WINDOW_DAYS = 30;

/**
 * Backs `AnalyticsModule.getTrafficSummary`.
 *
 * Living here rather than in the websites module is the point: `analytics_events` is
 * analytics-owned, and this is the one place the websites list learns anything about
 * it. Swapping the storage engine or changing how a visitor or a bounce is counted
 * touches this file and nothing in `modules/websites`.
 */
export class AnalyticsTrafficSummaryService {
  async summarizeSites(websiteIds: string[]): Promise<Map<string, TrafficSummary>> {
    const summaries = new Map<string, TrafficSummary>();
    // `inArray` with an empty list produces `IN ()`, which is invalid SQL.
    if (websiteIds.length === 0) return summaries;

    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

    // One grouped query for every site. The previous implementation ran two
    // sequential queries per site, so a user with twenty sites paid forty round
    // trips to render the list.
    const rows = await db
      .select({
        websiteId: analyticsEvents.websiteId,
        pageviews: sql<number>`count(*) filter (where ${analyticsEvents.eventType} = 'pageview')::int`,
        visitors: sql<number>`count(distinct ${analyticsEvents.visitorId})::int`,
      })
      .from(analyticsEvents)
      .where(
        and(inArray(analyticsEvents.websiteId, websiteIds), gte(analyticsEvents.occurredAt, since)),
      )
      .groupBy(analyticsEvents.websiteId);

    for (const row of rows) {
      summaries.set(row.websiteId, {
        totalPageviews: Number(row.pageviews ?? 0),
        uniqueVisitors: Number(row.visitors ?? 0),
        // Not yet derived here. Reported as zero rather than omitted so the
        // shape stays stable; the dashboard reads these from the dedicated
        // analytics endpoints, which compute them per-session.
        averageSessionDuration: 0,
        bounceRate: 0,
      });
    }

    // Sites with no traffic in the window are absent from `rows` and stay absent
    // from the map — callers fall back to `emptyTrafficSummary()`.
    return summaries;
  }
}
