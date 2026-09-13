import { log } from "../../../platform/lib/logger";
import {
  chronological,
  normalizeTrackerEvents,
  type TrackerBatchRoutingContext,
} from "./tracker-event-normalization.service";

export function routeRecordingEvents(ctx: TrackerBatchRoutingContext): void {
  if (!ctx.website.replay_enabled) return;
  const events = chronological(normalizeTrackerEvents(
    Array.isArray(ctx.body.session) ? ctx.body.session : [],
  ).map((event) => ({
    ...event,
    websiteId: ctx.website.id,
    data: event.data ?? {},
    ingestMeta: ctx.ingestMeta,
  })));
  if (events.length === 0) return;
  ctx.queue.enqueue("recordings", ctx.website.id, events);
  log.debug({ msg: "recordings_queued", website_id: ctx.website.id, n: events.length });
}
