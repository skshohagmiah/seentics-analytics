import { clampClientTs } from "../../../platform/lib/client-timestamp";
import { log } from "../../../platform/lib/logger";
import type { AutomationTriggerQueued } from "../../../platform/lib/types";
import {
  chronological,
  normalizeTrackerEvents,
  type TrackerBatchRoutingContext,
} from "./tracker-event-normalization.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function routeAutomationTriggers(ctx: TrackerBatchRoutingContext): void {
  if (!ctx.website.automation_enabled) return;
  const rows: AutomationTriggerQueued[] = [];
  const events = chronological(normalizeTrackerEvents(
    Array.isArray(ctx.body.automations) ? ctx.body.automations : [],
  ));
  for (const event of events) {
    if (event.type !== "automation_trigger" || !event.sid) continue;
    const data = event.data ?? {};
    const automationId = typeof data.automation_id === "string"
      ? data.automation_id
      : typeof data.automationId === "string" ? data.automationId : "";
    if (!UUID.test(automationId)) continue;
    const detail: Record<string, unknown> = { url: event.url, session_id: event.sid };
    if (event.vid) detail.visitor_id = event.vid;
    if (typeof data.name === "string") detail.name = data.name;
    if (typeof data.event === "string") detail.event = data.event;
    if (data.props && typeof data.props === "object" && !Array.isArray(data.props)) detail.props = data.props;
    rows.push({
      websiteId: ctx.website.id,
      automationId,
      occurredAt: new Date(clampClientTs(event.ts)),
      detail,
    });
  }
  if (rows.length === 0) return;
  ctx.queue.enqueue("automations", ctx.website.id, rows);
  log.debug({ msg: "automation_triggers_queued", website_id: ctx.website.id, n: rows.length });
}
