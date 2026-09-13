import { log } from "../../../platform/lib/logger";
import type { HeatmapTrackerEvent } from "../../heatmaps/interfaces";
import {
  chronological,
  normalizeTrackerEvents,
  type TrackerBatchRoutingContext,
} from "./tracker-event-normalization.service";

export function routeHeatmapEvents(ctx: TrackerBatchRoutingContext): void {
  if (!ctx.website.heatmap_enabled) return;
  const raw = [
    ...normalizeTrackerEvents(Array.isArray(ctx.body.heatmaps) ? ctx.body.heatmaps : []),
    ...normalizeTrackerEvents(Array.isArray(ctx.body.heatmap_screenshot) ? ctx.body.heatmap_screenshot : []),
    ...normalizeTrackerEvents(Array.isArray(ctx.body.heatmap_dom_snapshot) ? ctx.body.heatmap_dom_snapshot : []),
  ];
  if (raw.length === 0) return;
  const events: HeatmapTrackerEvent[] = raw.map((event) => ({
    ...event,
    websiteId: ctx.website.id,
    clientUa: ctx.userAgent,
    heatmapLayoutEnabled: ctx.website.heatmap_layout_enabled,
  }));
  ctx.queue.enqueue("heatmaps", ctx.website.id, chronological(events));
  log.debug({ msg: "heatmaps_queued", website_id: ctx.website.id, n: events.length });
}
