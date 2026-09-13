import { beforeEach, describe, expect, it } from "bun:test";
import type { AnalyticsIngestMeta } from "../../../platform/lib/analytics-ingest-meta";
import type { VisitorProfileWrite } from "../../automations/interfaces";
import type { TrackerEvent } from "../../../platform/lib/types";
import type { WebsiteTrackerRow } from "../../websites/interfaces";
import type { IngestQueue } from "../interfaces";
import {
  handleEvents,
  handleVisitorProfile,
  type CollectHandlerContext,
} from "../services/collect-handlers";

/**
 * The `/collect` sorters.
 *
 * Two things are worth pinning here and were not pinned anywhere before, because both were
 * wrong. The profile handler wrote to Postgres directly, once per request, un-awaited — the
 * only per-request database write on a path built to make none — and it parsed the request
 * body a second time to do it, walking up to two thousand events again on the hottest path
 * in the system. It also ignored `automation_enabled`, which every one of its siblings
 * honours, so it stored a visitor's geography and `identify()` traits for sites that do not
 * use the one feature that reads them.
 */

class FakeQueue implements IngestQueue {
  events: { websiteId: string; rows: TrackerEvent[] }[] = [];
  profiles: VisitorProfileWrite[] = [];

  enqueue(lane: string, websiteId: string, rows: readonly unknown[]): void {
    if (lane === "analytics") this.events.push({ websiteId, rows: rows as TrackerEvent[] });
    if (lane === "profiles") this.profiles.push(...(rows as VisitorProfileWrite[]));
  }
}

const ingestMeta = {
  country: "GB",
  region: "England",
  city: "London",
  device: "desktop",
  browser: "Chrome",
  os: "macOS",
  languageHint: "en-GB",
} as unknown as AnalyticsIngestMeta;

function website(overrides: Partial<WebsiteTrackerRow> = {}): WebsiteTrackerRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    url: "https://example.com",
    is_active: true,
    automation_enabled: true,
    funnel_enabled: true,
    heatmap_enabled: true,
    heatmap_layout_enabled: true,
    replay_enabled: true,
    ...overrides,
  } as unknown as WebsiteTrackerRow;
}

let queue: FakeQueue;

function ctxFor(events: unknown[], site = website()): CollectHandlerContext {
  return {
    body: { website_id: site.id, events } as CollectHandlerContext["body"],
    website: site,
    userAgent: "Mozilla/5.0",
    ingestMeta,
    queue,
  };
}

beforeEach(() => {
  queue = new FakeQueue();
});

describe("handleEvents", () => {
  it("buffers the analytics slice under the website id", () => {
    handleEvents(ctxFor([{ type: "pageview", sid: "s1", vid: "v1", url: "/a", ts: Date.now() }]));

    expect(queue.events).toHaveLength(1);
    expect(queue.events[0]!.websiteId).toBe(website().id);
    expect(queue.events[0]!.rows).toHaveLength(1);
  });

  /**
   * The parse is the expensive part of `/collect` and it was being done twice. Returning it
   * is what lets the profile handler share it — and the *unfiltered* list, because the two
   * handlers want different slices of it.
   */
  it("returns everything it parsed, including the types it does not buffer", () => {
    const parsed = handleEvents(
      ctxFor([
        { type: "pageview", sid: "s1", vid: "v1", url: "/a", ts: Date.now() },
        { type: "funnel_step", sid: "s1", vid: "v1", url: "/a", ts: Date.now() },
      ]),
    );

    expect(parsed).toHaveLength(2);
    // Only the pageview was buffered — funnel events go to their own branch.
    expect(queue.events[0]!.rows).toHaveLength(1);
  });

  it("returns the parse even when nothing survives the filter", () => {
    const parsed = handleEvents(
      ctxFor([{ type: "funnel_step", sid: "s1", vid: "v1", url: "/a", ts: Date.now() }]),
    );

    expect(parsed).toHaveLength(1);
    expect(queue.events).toEqual([]);
  });
});

describe("handleVisitorProfile", () => {
  const pageview = (vid: string) => ({
    type: "pageview",
    sid: "s1",
    vid,
    url: "/a",
    ts: Date.now(),
  });

  it("buffers a profile instead of writing one", () => {
    const ctx = ctxFor([pageview("v1")]);
    handleVisitorProfile(ctx, handleEvents(ctx));

    expect(queue.profiles).toHaveLength(1);
    expect(queue.profiles[0]).toMatchObject({
      websiteId: website().id,
      anonymousId: "v1",
      pageViews: 1,
      country: "GB",
      city: "London",
      device: "desktop",
      browser: "Chrome",
      os: "macOS",
      language: "en-GB",
    });
  });

  it("counts every pageview in the batch", () => {
    const ctx = ctxFor([pageview("v1"), pageview("v1"), pageview("v1")]);
    handleVisitorProfile(ctx, handleEvents(ctx));

    expect(queue.profiles[0]!.pageViews).toBe(3);
  });

  it("carries identify's user id and traits", () => {
    const ctx = ctxFor([
      pageview("v1"),
      {
        type: "identify",
        sid: "s1",
        vid: "v1",
        url: "/a",
        ts: Date.now(),
        data: { user_id: "  u-7 ", traits: { plan: "pro" } },
      },
    ]);
    handleVisitorProfile(ctx, handleEvents(ctx));

    expect(queue.profiles[0]).toMatchObject({ userId: "u-7", traits: { plan: "pro" } });
  });

  /**
   * The profile exists for automation conditions and is read by nothing else, so a site
   * with automations off was having its visitors' geography and traits stored for a feature
   * it does not use. Every sibling handler already checked its own flag.
   */
  it("writes nothing when the site has automations disabled", () => {
    const site = website({ automation_enabled: false } as Partial<WebsiteTrackerRow>);
    const ctx = ctxFor([pageview("v1")], site);
    handleVisitorProfile(ctx, handleEvents(ctx));

    expect(queue.profiles).toEqual([]);
  });

  it("writes nothing when no event carries a visitor id", () => {
    const ctx = ctxFor([{ type: "pageview", sid: "s1", url: "/a", ts: Date.now() }]);
    handleVisitorProfile(ctx, handleEvents(ctx));

    expect(queue.profiles).toEqual([]);
  });

  it("writes nothing for an empty batch", () => {
    const ctx = ctxFor([]);
    handleVisitorProfile(ctx, handleEvents(ctx));

    expect(queue.profiles).toEqual([]);
  });
});
