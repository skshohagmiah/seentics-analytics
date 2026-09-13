import type { TrackerCollectBody } from "../../../platform/lib/api-types";
import { buildAnalyticsIngestMeta } from "../../../platform/lib/analytics-ingest-meta";
import { log } from "../../../platform/lib/logger";
import type {
  IngestQueue,
  ProcessTrackerCollectInput,
  ProcessTrackerCollectResult,
  TrackerCollectService,
} from "../interfaces";
import { routeAnalyticsEvents } from "./analytics-event-routing.service";
import { routeAutomationTriggers } from "./automation-trigger-routing.service";
import { routeFunnelEvents } from "./funnel-event-routing.service";
import { routeHeatmapEvents } from "./heatmap-event-routing.service";
import { routeRecordingEvents } from "./recording-event-routing.service";
import { routeVisitorProfile } from "./visitor-profile-routing.service";

export function createTrackerCollectService(queue: IngestQueue): TrackerCollectService {
  return {
    process(input) {
      return processTrackerCollect(input, queue);
    },
  };
}

function processTrackerCollect(
  input: ProcessTrackerCollectInput,
  queue: IngestQueue,
): ProcessTrackerCollectResult {
  const { body, website, headers } = input;
  const queued = trackerCollectItemCount(body);
  if (queued === 0) return { kind: "empty" };

  const consentGranted = (body as Record<string, unknown>).consent === true;
  if ((website.respect_dnt && headers.get("DNT") === "1") ||
      (website.consent_mode === "strict" && !consentGranted)) {
    return { kind: "privacy-disabled" };
  }

  const userAgent = trackerUserAgent(body, headers.get("User-Agent") ?? "");
  const ingestMeta = buildAnalyticsIngestMeta({
    userAgent,
    clientIp: input.clientIp,
    acceptLanguage: headers.get("Accept-Language") ?? "",
    headers,
  });
  const context = { body, website, userAgent, ingestMeta, queue };

  const fields = {
    msg: "tracker_collect" as const,
    website_param: input.websiteParam,
    website_uuid: website.id,
    website_id: website.id,
    origin: input.origin,
    len_events: lengthOf(body.events),
    len_session: lengthOf(body.session),
    len_heatmaps: lengthOf(body.heatmaps),
    len_heatmap_screenshot: lengthOf(body.heatmap_screenshot),
    len_funnels: lengthOf(body.funnels),
    len_automations: lengthOf(body.automations),
    event_types_sample: eventTypes(body.events),
  };
  log.debug(fields);
  if (input.diagnosticLog) log.info(fields);

  routeVisitorProfile(context, routeAnalyticsEvents(context));
  routeFunnelEvents(context);
  routeAutomationTriggers(context);
  routeRecordingEvents(context);
  routeHeatmapEvents(context);

  return { kind: "processed", queued };
}

export function trackerCollectItemCount(body: TrackerCollectBody): number {
  return lengthOf(body.events) + lengthOf(body.session) + lengthOf(body.heatmaps) +
    lengthOf(body.heatmap_screenshot) + lengthOf(body.funnels) + lengthOf(body.automations);
}

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function eventTypes(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  return [...new Set(events.slice(0, 40)
    .map((event) => event && typeof event === "object" && "type" in event
      ? String((event as { type?: string }).type ?? "")
      : "")
    .filter(Boolean))].slice(0, 15);
}

function trackerUserAgent(body: TrackerCollectBody, header: string): string {
  if (header && !/^(bun\/|node\/|node-fetch|undici|got\/|axios\/)/i.test(header)) {
    return header;
  }

  const bodyUserAgent = typeof body.ua === "string" ? body.ua.trim() : "";
  if (bodyUserAgent) return bodyUserAgent;

  for (const event of Array.isArray(body.events) ? body.events : []) {
    const data = (event as Record<string, unknown> | null)?.data;
    const userAgent = typeof (data as Record<string, unknown> | null)?.ua === "string"
      ? ((data as Record<string, unknown>).ua as string).trim()
      : "";
    if (userAgent) return userAgent;
  }
  return header;
}
