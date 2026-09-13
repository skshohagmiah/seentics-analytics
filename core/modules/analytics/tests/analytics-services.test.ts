import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  drizzleCalls,
  fakeDbModule,
  fakeLogger,
  queueDrizzleRows,
  queueRows,
  resetDb,
} from "./helpers/fake-db";
import type { WebsitePublicSharing } from "../../websites/interfaces";

/**
 * The two analytics services that are orchestration rather than query: the public
 * share link, and the per-site traffic rollup the websites list renders.
 *
 * Both exist to keep a cross-module read out of the other module — the share link
 * resolves through a websites port instead of selecting from `websites`, and the
 * rollup owns the only `analytics_events` read the websites list performs. Those
 * boundaries are what the tests assert, alongside the shaping.
 */

mock.module("../../../db", fakeDbModule);
mock.module("../../../platform/lib/logger", fakeLogger);

/* eslint-disable @typescript-eslint/no-explicit-any */
let PublicDashboardService: any;
let AnalyticsTrafficSummaryService: any;

beforeAll(async () => {
  ({ PublicDashboardService } = await import("../services/public-dashboard-analytics.service"));
  ({ AnalyticsTrafficSummaryService } = await import("../services/website-traffic-summary.service"));
});

beforeEach(resetDb);

// ─── Public dashboard ────────────────────────────────────────────────────────

/** Resolves share links; every other member would be a boundary violation if reached. */
class FakeSharing implements WebsitePublicSharing {
  links = new Map<string, string>();
  lookups: string[] = [];

  async resolvePublicShareId(publicShareId: string) {
    this.lookups.push(publicShareId);
    const websiteId = this.links.get(publicShareId);
    return websiteId ? { websiteId } : null;
  }
}

/** The three result sets `getDashboardStats` consumes. */
function dashboardRows(pv = 0, uv = 0) {
  queueRows(
    [{ pv, uv, prev_pv: 0, prev_uv: 0 }],
    [
      {
        session_cnt: 0,
        avg_session_sec: 0,
        bounce_pct: 0,
        prev_session_cnt: 0,
        prev_avg_session_sec: 0,
        prev_bounce_pct: 0,
      },
    ],
    [{ c: 0 }],
  );
}

describe("PublicDashboardService", () => {
  let sharing: FakeSharing;
  let service: { getPublicDashboard: (id: string, q: Record<string, string>) => Promise<any> };

  beforeEach(() => {
    sharing = new FakeSharing();
    sharing.links.set("share_live", "site_1");
    service = new PublicDashboardService(sharing);
  });

  it("resolves the share link through the websites port", async () => {
    dashboardRows();
    await service.getPublicDashboard("share_live", {});
    expect(sharing.lookups).toEqual(["share_live"]);
  });

  it("answers the same dashboard payload the authenticated endpoint serves", async () => {
    // Same repository, so a share link cannot drift into showing different numbers
    // from the owner's own dashboard.
    dashboardRows(500, 120);
    const out = await service.getPublicDashboard("share_live", { days: "30" });

    expect(out.website_id).toBe("site_1");
    expect(out.page_views).toBe(500);
    expect(out.unique_visitors).toBe(120);
    expect(out.date_range).toBe("30d");
  });

  it("queries the resolved website id, not the share id", async () => {
    // The share id must never reach `analytics_events.website_id`, which would return
    // a confident empty dashboard rather than an error.
    dashboardRows();
    await service.getPublicDashboard("share_live", {});
    expect((await import("./helpers/fake-db")).sqlCalls[0]!.values).toContain("site_1");
  });

  it("threads the query bag through to the repository", async () => {
    dashboardRows();
    const out = await service.getPublicDashboard("share_live", { days: "90" });
    expect(out.date_range).toBe("90d");
  });

  it("returns null for an unknown link, without querying", async () => {
    // `null` rather than a throw: the route turns it into a 404, and a revoked link is
    // an expected state rather than an error worth a stack trace.
    const out = await service.getPublicDashboard("share_unknown", {});
    expect(out).toBeNull();
    expect((await import("./helpers/fake-db")).sqlCalls).toHaveLength(0);
  });

  it("returns null once a link is revoked", async () => {
    dashboardRows();
    expect(await service.getPublicDashboard("share_live", {})).not.toBeNull();

    resetDb();
    sharing.links.delete("share_live");
    expect(await service.getPublicDashboard("share_live", {})).toBeNull();
  });

  it("re-resolves on every request rather than caching the mapping", async () => {
    dashboardRows();
    await service.getPublicDashboard("share_live", {});
    resetDb();
    dashboardRows();
    await service.getPublicDashboard("share_live", {});
    expect(sharing.lookups).toEqual(["share_live", "share_live"]);
  });
});

// ─── Traffic summary rollup ──────────────────────────────────────────────────

describe("AnalyticsTrafficSummaryService", () => {
  let service: { summarizeSites: (ids: string[]) => Promise<Map<string, any>> };

  beforeEach(() => {
    service = new AnalyticsTrafficSummaryService();
  });

  it("returns an empty map for an empty site list without querying", async () => {
    // `inArray` with an empty list generates `IN ()`, which is a syntax error — the
    // early return is load-bearing, not a micro-optimisation.
    const out = await service.summarizeSites([]);
    expect(out.size).toBe(0);
    expect(drizzleCalls).toHaveLength(0);
  });

  it("answers every site in one grouped query rather than one query per site", async () => {
    queueDrizzleRows([
      { websiteId: "a", pageviews: 10, visitors: 4 },
      { websiteId: "b", pageviews: 3, visitors: 2 },
    ]);
    await service.summarizeSites(["a", "b", "c"]);

    expect(drizzleCalls.filter((c) => c.stage === "select")).toHaveLength(1);
    expect(drizzleCalls.filter((c) => c.stage === "groupBy")).toHaveLength(1);
  });

  it("keys the map by website id", async () => {
    queueDrizzleRows([
      { websiteId: "a", pageviews: 10, visitors: 4 },
      { websiteId: "b", pageviews: 3, visitors: 2 },
    ]);
    const out = await service.summarizeSites(["a", "b"]);

    expect(out.get("a")).toEqual({
      totalPageviews: 10,
      uniqueVisitors: 4,
      averageSessionDuration: 0,
      bounceRate: 0,
    });
    expect(out.get("b")!.totalPageviews).toBe(3);
  });

  it("omits a site with no traffic so the caller can apply its own empty summary", async () => {
    queueDrizzleRows([{ websiteId: "a", pageviews: 10, visitors: 4 }]);
    const out = await service.summarizeSites(["a", "quiet"]);

    expect(out.has("a")).toBe(true);
    expect(out.has("quiet")).toBe(false);
  });

  it("reports the not-yet-derived fields as zero rather than omitting them", async () => {
    // Shape stability: the websites list reads all four fields, and the two real ones
    // come from the dedicated analytics endpoints.
    queueDrizzleRows([{ websiteId: "a", pageviews: 10, visitors: 4 }]);
    const summary = (await service.summarizeSites(["a"])).get("a")!;
    expect(summary.averageSessionDuration).toBe(0);
    expect(summary.bounceRate).toBe(0);
  });

  it("coerces null counts to zero", async () => {
    queueDrizzleRows([{ websiteId: "a", pageviews: null, visitors: null }]);
    const summary = (await service.summarizeSites(["a"])).get("a")!;
    expect(summary.totalPageviews).toBe(0);
    expect(summary.uniqueVisitors).toBe(0);
  });

  it("coerces string counts to numbers", async () => {
    queueDrizzleRows([{ websiteId: "a", pageviews: "10", visitors: "4" }]);
    const summary = (await service.summarizeSites(["a"])).get("a")!;
    expect(summary.totalPageviews).toBe(10);
    expect(summary.uniqueVisitors).toBe(4);
  });

  it("returns an empty map when no site in the list has traffic", async () => {
    queueDrizzleRows([]);
    expect((await service.summarizeSites(["a", "b"])).size).toBe(0);
  });
});
