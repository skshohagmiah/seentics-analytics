import { log } from "../../../platform/lib/logger";
import type { TrackerEvent } from "../../../platform/lib/types";
import { TRACKER_FUNNEL_EVENT_TYPES } from "../../funnels/interfaces";
import {
  attachIngestMetadata,
  chronological,
  normalizeTrackerEvents,
  type TrackerBatchRoutingContext,
} from "./tracker-event-normalization.service";

const AUTOMATION_EVENTS = new Set(["automation_trigger"]);

export function routeAnalyticsEvents(ctx: TrackerBatchRoutingContext): TrackerEvent[] {
  const parsed = normalizeTrackerEvents(Array.isArray(ctx.body.events) ? ctx.body.events : []);
  const analyticsEvents = parsed.filter(
    (event) => !TRACKER_FUNNEL_EVENT_TYPES.has(event.type) && !AUTOMATION_EVENTS.has(event.type),
  );
  if (analyticsEvents.length > 0) {
    const queued = attachIngestMetadata(chronological(analyticsEvents), ctx.ingestMeta);
    ctx.queue.enqueue("analytics", ctx.website.id, queued);
    log.debug({ msg: "events_queued", website_id: ctx.website.id, n: queued.length });
  }
  return parsed;
}
