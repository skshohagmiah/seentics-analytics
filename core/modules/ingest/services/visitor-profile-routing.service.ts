import type { TrackerEvent } from "../../../platform/lib/types";
import type { TrackerBatchRoutingContext } from "./tracker-event-normalization.service";

export function routeVisitorProfile(
  ctx: TrackerBatchRoutingContext,
  events: TrackerEvent[],
): void {
  if (!ctx.website.automation_enabled || events.length === 0) return;
  const anonymousId = events.find((event) => event.vid)?.vid ?? "";
  if (!anonymousId) return;
  let pageViews = 0;
  let userId: string | undefined;
  let traits: Record<string, unknown> | undefined;
  for (const event of events) {
    if (event.type === "pageview") pageViews++;
    if (event.type !== "identify") continue;
    const data = event.data ?? {};
    const identifiedUser = typeof data.user_id === "string" ? data.user_id.trim() : "";
    if (identifiedUser) userId = identifiedUser;
    if (data.traits && typeof data.traits === "object" && !Array.isArray(data.traits)) {
      traits = { ...(traits ?? {}), ...(data.traits as Record<string, unknown>) };
    }
  }
  const meta = ctx.ingestMeta;
  ctx.queue.enqueue("profiles", ctx.website.id, [{
    websiteId: ctx.website.id,
    anonymousId,
    userId,
    traits,
    pageViews,
    country: meta.country ?? null,
    region: meta.region ?? null,
    city: meta.city ?? null,
    device: meta.device ?? null,
    browser: meta.browser ?? null,
    os: meta.os ?? null,
    language: meta.languageHint ?? null,
  }]);
}
