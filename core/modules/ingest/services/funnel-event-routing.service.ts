import { log } from "../../../platform/lib/logger";
import { TRACKER_FUNNEL_EVENT_TYPES } from "../../funnels/interfaces";
import {
  attachIngestMetadata,
  chronological,
  normalizeTrackerEvents,
  type TrackerBatchRoutingContext,
} from "./tracker-event-normalization.service";

export function routeFunnelEvents(ctx: TrackerBatchRoutingContext): void {
  if (!ctx.website.funnel_enabled) return;
  const events = normalizeTrackerEvents(Array.isArray(ctx.body.funnels) ? ctx.body.funnels : [])
    .filter((event) => TRACKER_FUNNEL_EVENT_TYPES.has(event.type) && event.sid);
  if (events.length === 0) return;
  const queued = attachIngestMetadata(chronological(events), ctx.ingestMeta);
  ctx.queue.enqueue("funnels", ctx.website.id, queued);
  log.debug({ msg: "funnel_events_queued", website_id: ctx.website.id, n: queued.length });
}
