import type { TrackerCollectBody } from "../../../platform/lib/api-types";
import type { AnalyticsIngestMeta } from "../../../platform/lib/analytics-ingest-meta";
import type { WebsiteTrackerRow } from "../../websites/interfaces";
import type {
  AutomationTriggerQueued,
  TrackerEvent,
} from "../../../platform/lib/types";
import { clampClientTs } from "../../../platform/lib/client-timestamp";
import { TRACKER_FUNNEL_EVENT_TYPES } from "../../funnels/interfaces";
import type { HeatmapTrackerEvent } from "../../heatmaps/interfaces";
import type { IngestQueue } from "../interfaces";
import { log as baseLog } from "../../../platform/lib/logger";

const log = baseLog.child({ category: "ingest" });

const ROUTED_TO_AUTOMATIONS = new Set(["automation_trigger"]);

const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return uuidRe.test(s);
}

/** Parse a client ts (number or numeric string) and clamp it to the server sanity window. */
function flexTs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return clampClientTs(Math.trunc(v));
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return clampClientTs(Math.trunc(n));
  }
  return Date.now();
}

function asDataMap(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function parseCollectEvents(raw: unknown[]): TrackerEvent[] {
  const out: TrackerEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";
    const sid = typeof o.sid === "string" ? o.sid : "";
    const vid = typeof o.vid === "string" ? o.vid : undefined;
    const url = typeof o.url === "string" ? o.url : "";
    let doc_w: number | undefined;
    let doc_h: number | undefined;
    if (typeof o.doc_w === "number" && Number.isFinite(o.doc_w)) doc_w = o.doc_w;
    if (typeof o.doc_h === "number" && Number.isFinite(o.doc_h)) doc_h = o.doc_h;
    out.push({
      type,
      data: asDataMap(o.data),
      ts: flexTs(o.ts),
      url,
      sid,
      vid,
      websiteId: "",
      doc_w,
      doc_h,
    });
  }
  return out;
}

function sortByTs<T extends { ts: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.ts - b.ts);
}

/**
 * Stamp the request's server-derived metadata onto each event.
 *
 * Per event rather than per batch because the buffer accumulates across requests and each
 * one has its own geo and device. This is ingest's job — the values come from the request,
 * never from the payload — where projecting into a module's row shape was not.
 */
function withIngestMeta(rows: TrackerEvent[], ingestMeta: AnalyticsIngestMeta): TrackerEvent[] {
  return rows.map((e) => ({ ...e, ingestMeta }));
}

export type CollectHandlerContext = {
  body: TrackerCollectBody;
  website: WebsiteTrackerRow;
  userAgent: string;
  ingestMeta: AnalyticsIngestMeta;
  /**
   * Where sorted events are buffered.
   *
   * Carried on the per-request context rather than imported: the queue used to be a
   * set of module-level functions, so these handlers reached for a singleton and
   * could not be exercised without it. Arriving here, a test drives them with a
   * fake and the routes pass whichever queue the composition root built.
   */
  queue: IngestQueue;
};

/**
 * Route the plain-event slice of a `/collect` body to the analytics buffer.
 *
 * Sorts, filters by category, and attaches the request's server-derived `ingestMeta` —
 * ingest's three genuine jobs. It no longer *projects* the rows into
 * `analytics_events`' shape: that is analytics' own column layout, and it belongs with the
 * table now that a buffered batch becomes a durable queue row.
 */
export function handleEvents(ctx: CollectHandlerContext): TrackerEvent[] {
  const page = parseCollectEvents(Array.isArray(ctx.body.events) ? ctx.body.events : []);
  const filtered = page.filter(
    (e) => !TRACKER_FUNNEL_EVENT_TYPES.has(e.type) && !ROUTED_TO_AUTOMATIONS.has(e.type),
  );
  if (!filtered.length) return page;
  const forDb = withIngestMeta(sortByTs(filtered), ctx.ingestMeta);
  ctx.queue.enqueue('analytics', ctx.website.id, forDb);
  log.debug({ msg: "events_queued", website_id: ctx.website.id, n: forDb.length });
  // Returned so `handleVisitorProfile` does not parse the same body a second time. The
  // unfiltered list, because the profile counts pageviews and reads `identify` traits —
  // and `identify` is one of the types the analytics filter above keeps, so the two
  // handlers genuinely want different slices of the same parse.
  return page;
}

/**
 * Keep the visitor profile current from the batch we already have.
 *
 * The profile is what gives automation conditions anything to say about the *person*
 * rather than the page. It was never written — see `visitor-profile.service` — so
 * conditions on country, device or visit count could not be true.
 *
 * Everything used here was already computed for the analytics rows: `ctx.ingestMeta`
 * carries the MaxMind geography and the parsed user agent, and the visitor id rides on
 * the events. No extra lookup, no extra request — and it re-parses nothing, because
 * `handleEvents` hands it the events it already parsed. Parsing the body a second time
 * here cost a full pass over up to two thousand events on the hottest path in the system.
 *
 * Buffered, not written. This used to call the writer directly and `void` the promise,
 * which made it the only per-request database write on a path whose entire design is that
 * it makes none — one upsert per `/collect`, and the tracker sends one every five seconds
 * per visitor. Being un-awaited it also applied no backpressure: a burst put unbounded
 * concurrent statements on the pool the analytics inserts share.
 *
 * Gated on `automation_enabled`, like every other handler here. The profile exists for
 * automation conditions and is read by nothing else, so writing one for a site with
 * automations switched off stored a visitor's country, city and `identify()` traits for a
 * feature that site does not use.
 */
export function handleVisitorProfile(ctx: CollectHandlerContext, parsed: TrackerEvent[]): void {
  if (!ctx.website.automation_enabled) return;
  const events = parsed;
  if (!events.length) return;

  // Any event carries the visitor id; the first one that has it is enough.
  const anonymousId = events.find((e) => e.vid)?.vid ?? "";
  if (!anonymousId) return;

  let pageViews = 0;
  let userId: string | undefined;
  let traits: Record<string, unknown> | undefined;

  for (const e of events) {
    if (e.type === "pageview") pageViews++;
    if (e.type !== "identify") continue;

    // `seentics.identify(userId, traits)` sends `{ user_id, traits }`. Until now those
    // landed in the event stream and stopped there, so a trait could never be a fact.
    const d = e.data ?? {};
    const uid = typeof d.user_id === "string" ? d.user_id.trim() : "";
    if (uid) userId = uid;
    const t = d.traits;
    if (t && typeof t === "object" && !Array.isArray(t)) {
      traits = { ...(traits ?? {}), ...(t as Record<string, unknown>) };
    }
  }

  const meta = ctx.ingestMeta;
  ctx.queue.enqueue('profiles', ctx.website.id, [
    {
      websiteId: ctx.website.id,
      anonymousId,
      userId,
      traits,
      pageViews,
      country: meta?.country ?? null,
      region: meta?.region ?? null,
      city: meta?.city ?? null,
      device: meta?.device ?? null,
      browser: meta?.browser ?? null,
      os: meta?.os ?? null,
      language: meta?.languageHint ?? null,
    },
  ]);
}

export function handleFunnels(ctx: CollectHandlerContext): void {
  if (!ctx.website.funnel_enabled) return;
  const raw = parseCollectEvents(Array.isArray(ctx.body.funnels) ? ctx.body.funnels : []);
  const only = raw.filter((e) => TRACKER_FUNNEL_EVENT_TYPES.has(e.type) && e.sid);
  if (!only.length) return;
  const forDb = withIngestMeta(sortByTs(only), ctx.ingestMeta);
  ctx.queue.enqueue('funnels', ctx.website.id, forDb);
  log.debug({ msg: "funnel_events_queued", website_id: ctx.website.id, n: forDb.length });
}

export function handleAutomations(ctx: CollectHandlerContext): void {
  if (!ctx.website.automation_enabled) return;
  const raw = parseCollectEvents(Array.isArray(ctx.body.automations) ? ctx.body.automations : []);
  const rows: AutomationTriggerQueued[] = [];
  const sorted = sortByTs(raw);
  for (const e of sorted) {
    if (e.type !== "automation_trigger" || !e.sid) continue;
    const dm = e.data ?? {};
    const aid =
      typeof dm.automation_id === "string"
        ? dm.automation_id
        : typeof dm.automationId === "string"
          ? dm.automationId
          : "";
    if (!isUuid(aid)) continue;
    const ts = clampClientTs(e.ts);
    const detail: Record<string, unknown> = { url: e.url, session_id: e.sid };
    if (e.vid) detail.visitor_id = e.vid;
    if (typeof dm.name === "string") detail.name = dm.name;
    if (typeof dm.event === "string") detail.event = dm.event;
    if (dm.props && typeof dm.props === "object" && !Array.isArray(dm.props)) {
      detail.props = dm.props;
    }
    rows.push({
      websiteId: ctx.website.id,
      automationId: aid,
      occurredAt: new Date(ts),
      detail,
    });
  }
  if (!rows.length) return;
  ctx.queue.enqueue('automations', ctx.website.id, rows);
  log.debug({ msg: "automation_triggers_queued", website_id: ctx.website.id, n: rows.length });
}

export function handleRecordings(ctx: CollectHandlerContext): void {
  if (!ctx.website.replay_enabled) return;
  const sessions = parseCollectEvents(Array.isArray(ctx.body.session) ? ctx.body.session : []);
  // Context attached, nothing filtered: recordings decides which types are its own.
  const prepared = sortByTs(
    sessions.map((e) => ({
      ...e,
      websiteId: ctx.website.id,
      data: e.data ?? {},
      ingestMeta: ctx.ingestMeta,
    })),
  );
  if (!prepared.length) return;
  ctx.queue.enqueue('recordings', ctx.website.id, prepared);
  log.debug({ msg: "recordings_queued", website_id: ctx.website.id, n: prepared.length });
}

export function handleHeatmaps(ctx: CollectHandlerContext): void {
  if (!ctx.website.heatmap_enabled) return;

  // One pass over all four heatmap slices of the body. Which of those types this module
  // owns, and what its rows look like, is heatmaps' knowledge — so everything here is
  // routing: parse, attach the per-request context, buffer.
  const raw = [
    ...parseCollectEvents(Array.isArray(ctx.body.heatmaps) ? ctx.body.heatmaps : []),
    ...parseCollectEvents(
      Array.isArray(ctx.body.heatmap_screenshot) ? ctx.body.heatmap_screenshot : [],
    ),
    ...parseCollectEvents(
      Array.isArray(ctx.body.heatmap_dom_snapshot) ? ctx.body.heatmap_dom_snapshot : [],
    ),
  ];
  if (!raw.length) return;

  // Per event, not per batch: the buffer accumulates across requests, so it holds events
  // from many visitors and many websites at once.
  const withContext: HeatmapTrackerEvent[] = raw.map((e) => ({
    ...e,
    websiteId: ctx.website.id,
    clientUa: ctx.userAgent,
    heatmapLayoutEnabled: ctx.website.heatmap_layout_enabled,
  }));

  ctx.queue.enqueue('heatmaps', ctx.website.id, sortByTs(withContext));
  log.debug({ msg: "heatmaps_queued", website_id: ctx.website.id, n: withContext.length });
}
