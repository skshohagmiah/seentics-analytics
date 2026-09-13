import { and, desc, eq } from "drizzle-orm";
import { analyticsEvents, db } from "../../../db";
import type { AnalyticsPageviewUrls } from "../interfaces";

/**
 * How many recent pageviews to scan when hunting for a concrete URL to screenshot.
 * Large enough that a low-traffic page still appears, small enough to stay a single
 * index scan.
 */
const RECENT_PAGEVIEW_SCAN_LIMIT = 200;

/**
 * Backs `AnalyticsPageviewUrls`.
 *
 * The query moved here from `modules/heatmaps/repositories/pageview-url.repository.ts`
 * unchanged. Heatmaps wanted it as a fallback source of *real* URLs to screenshot when
 * a page's URL cannot be derived from the website's registered domain; what changed is
 * that the `analytics_events` projection now lives with the module that owns the table.
 */
export class AnalyticsPageviewUrlService implements AnalyticsPageviewUrls {
  async listRecentPageviewUrls(websiteId: string): Promise<string[]> {
    const rows = await db
      .select({ page: analyticsEvents.page })
      .from(analyticsEvents)
      .where(and(eq(analyticsEvents.websiteId, websiteId), eq(analyticsEvents.eventType, "pageview")))
      .orderBy(desc(analyticsEvents.occurredAt))
      .limit(RECENT_PAGEVIEW_SCAN_LIMIT);

    return rows.map((r) => r.page).filter((p): p is string => !!p);
  }
}
