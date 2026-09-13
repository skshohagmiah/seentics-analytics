import { and, desc, eq, gte, lte } from "drizzle-orm";
import { analyticsEvents, db } from "../../../db";
import type { AnalyticsFunnelEvents, AnalyticsRawEvents } from "../interfaces";
import { countFunnelStepVisitors } from "../repositories/funnel-events.repository";

/**
 * Backs `AnalyticsRawEvents` and `AnalyticsFunnelEvents`.
 *
 * Both queries moved here from the modules that used to run them against this module's
 * table — the raw API from `platform/public-api`, the funnel step counts from
 * `modules/funnels/repositories/funnel-report.repository.ts`. Neither projection
 * changed; what changed is that a column rename in `analytics_events` is now a
 * compile-or-test failure in the module that owns it rather than a silent wrong answer
 * two modules away.
 */
export class AnalyticsEventFeedService implements AnalyticsRawEvents, AnalyticsFunnelEvents {
  async listRawEvents(
    websiteId: string,
    q: { from?: Date; to?: Date; limit: number; offset: number; eventType?: string },
  ) {
    const cond = [eq(analyticsEvents.websiteId, websiteId)];
    if (q.from) cond.push(gte(analyticsEvents.occurredAt, q.from));
    if (q.to) cond.push(lte(analyticsEvents.occurredAt, q.to));
    if (q.eventType) cond.push(eq(analyticsEvents.eventType, q.eventType));

    const rows = await db
      .select({
        id: analyticsEvents.id,
        eventType: analyticsEvents.eventType,
        page: analyticsEvents.page,
        visitorId: analyticsEvents.visitorId,
        sessionId: analyticsEvents.sessionId,
        occurredAt: analyticsEvents.occurredAt,
        properties: analyticsEvents.properties,
      })
      .from(analyticsEvents)
      .where(and(...cond))
      // Stable total order: occurred_at can tie, so the unique PK is the tiebreaker.
      // Without it, offset pagination can skip or duplicate rows.
      .orderBy(desc(analyticsEvents.occurredAt), desc(analyticsEvents.id))
      .limit(q.limit)
      .offset(q.offset);

    return rows.map((e) => ({
      id: e.id,
      event_type: e.eventType,
      page: e.page,
      visitor_id: e.visitorId,
      session_id: e.sessionId,
      occurred_at: e.occurredAt.toISOString(),
      properties: e.properties ?? null,
    }));
  }

  async countFunnelStepVisitors(
    websiteId: string,
    funnelId: string,
    startIso: string,
    endIso: string,
  ) {
    return countFunnelStepVisitors(websiteId, funnelId, startIso, endIso);
  }
}
