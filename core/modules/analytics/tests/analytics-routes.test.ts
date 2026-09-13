import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Website, WebsiteQuery, WebsiteRole } from "../../websites/interfaces";
import type { AnalyticsPublicDashboard, AnalyticsQueryParams, AnalyticsReads } from "../interfaces";
import { testConfig } from "../../../app/tests/helpers/test-config";

// ─── Mocks — registered before the dynamic import at the bottom ──────────────
//
// Only the JWT middleware is faked. The validators, the router, and the guard are all
// real, and nothing here reaches a database: the analytics module is injected as a
// recording stub, which is the seam the route factory exists to provide.
//
// `X-Test-User` stands in for a verified token so the 401 (no token) and 403 (token,
// no access) paths can be driven independently.

mock.module("../../../platform/middleware/auth", () => ({
  authMiddleware: async (c: Context<{ Variables: { userId: string } }>, next: Next) => {
    const userId = c.req.header("X-Test-User");
    if (!userId) return c.json({ error: "Authorization required" }, 401);
    c.set("userId", userId);
    return next();
  },
  requireUser: (c: Context<{ Variables: { userId: string } }>) => c.get("userId") ?? null,
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WEBSITE = "11111111-1111-4111-8111-111111111111";
/** A syntactically valid reference that resolves to nothing — must not be distinguishable. */
const UNKNOWN_WEBSITE = "22222222-2222-4222-8222-222222222222";
const OWNER = "user_owner";
const MEMBER = "user_member";
const STRANGER = "user_stranger";

/** One recorded call into the analytics module. */
type Recorded = { method: string; args: unknown[] };

/**
 * Every read method, recorded rather than implemented.
 *
 * Built from the method table below so the stub and the route table can never drift:
 * a method added to `AnalyticsReads` without a route (or the reverse) shows up as a
 * failure in the coverage test at the end of this file rather than as silence.
 */
const WINDOWED_ROUTES = [
  { path: "dashboard", method: "getDashboard" },
  { path: "traffic-summary", method: "getTrafficSummary" },
  { path: "daily-stats", method: "getDailyStats" },
  { path: "hourly-stats", method: "getHourlyStats" },
  { path: "top-pages", method: "getPages" },
  { path: "top-referrers", method: "getReferrers" },
  { path: "top-sources", method: "getSources" },
  { path: "top-browsers", method: "getBrowsers" },
  { path: "top-devices", method: "getDevices" },
  { path: "top-os", method: "getOperatingSystems" },
  { path: "top-countries", method: "getCountries" },
  { path: "top-cities", method: "getCities" },
  { path: "top-languages", method: "getLanguages" },
  { path: "top-resolutions", method: "getResolutions" },
  { path: "geolocation-breakdown", method: "getGeolocation" },
  { path: "page-utm-breakdown", method: "getPageUtmBreakdown" },
  { path: "dimensions-bulk", method: "getDimensionsBulk" },
  { path: "activity-trends", method: "getActivityTrends" },
  { path: "path-analysis", method: "getPathAnalysis" },
  { path: "visitor-insights", method: "getVisitorInsights" },
  { path: "custom-events", method: "getCustomEvents" },
  { path: "goals-stats", method: "getGoals" },
  { path: "revenue", method: "getRevenueDashboard" },
  { path: "export", method: "exportEvents" },
] as const;

/** Reads whose window is fixed or minute-based, so they do not take the shared query bag. */
const NON_WINDOWED_ROUTES = [
  { path: "realtime", method: "getRealtime" },
  { path: "live-visitors", method: "getLiveVisitors" },
  { path: "recent-activity", method: "getRecentActivity" },
  { path: "realtime-geo", method: "getRealtimeGeo" },
] as const;

const ALL_GUARDED_ROUTES = [...WINDOWED_ROUTES, ...NON_WINDOWED_ROUTES];

class FakeAnalytics {
  calls: Recorded[] = [];
  /** Per-method payload; every read answers this unless overridden. */
  payload: unknown = { ok: true };
  /** When set, the named method throws — exercising the router's error path. */
  throwOn: string | null = null;

  private record(method: string, args: unknown[]): unknown {
    this.calls.push({ method, args });
    if (this.throwOn === method) throw new Error("repository exploded");
    return this.payload;
  }

  callsTo(method: string): Recorded[] {
    return this.calls.filter((c) => c.method === method);
  }

  onlyCall(): Recorded {
    if (this.calls.length !== 1) {
      throw new Error(`expected exactly one analytics call, got ${this.calls.length}`);
    }
    return this.calls[0]!;
  }
}

/** Materialise `FakeAnalytics` into something structurally satisfying `AnalyticsReads`. */
function makeAnalytics(): FakeAnalytics & AnalyticsReads {
  const fake = new FakeAnalytics();
  for (const { method } of ALL_GUARDED_ROUTES) {
    (fake as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fake as unknown as { record: (m: string, a: unknown[]) => unknown })["record"].call(
        fake,
        method,
        args,
      );
  }
  return fake as FakeAnalytics & AnalyticsReads;
}

function analyticsControllerServices(analytics: AnalyticsReads) {
  return {
    dashboard: analytics,
    dimensions: analytics,
    realtime: analytics,
    journeys: analytics,
    conversions: analytics,
    exporter: analytics,
  };
}

/** Only `getRole` is reachable from the routes; anything else would be a boundary break. */
class FakeWebsiteQuery implements WebsiteQuery {
  roles = new Map<string, WebsiteRole>();
  roleLookups: Array<{ ref: string; userId: string }> = [];

  grant(ref: string, userId: string, role: WebsiteRole): void {
    this.roles.set(`${ref}:${userId}`, role);
  }

  async getRole(ref: string, userId: string): Promise<WebsiteRole | null> {
    this.roleLookups.push({ ref, userId });
    return this.roles.get(`${ref}:${userId}`) ?? null;
  }

  async getById(): Promise<Website | null> {
    throw new Error("routes must not resolve websites themselves — that is the service's job");
  }

  async listOwnedBy(): Promise<Website[]> {
    throw new Error("unused");
  }
}

class FakePublicDashboard implements AnalyticsPublicDashboard {
  calls: Array<{ publicId: string; query: AnalyticsQueryParams }> = [];
  result: unknown | null = { website_id: WEBSITE, page_views: 5 };

  async getPublicDashboard(publicShareId: string, query: AnalyticsQueryParams) {
    this.calls.push({ publicId: publicShareId, query });
    return this.result;
  }
}

// ─── Load the factory after the mocks ────────────────────────────────────────

let createAnalyticsRoutes: typeof import("../routes").createAnalyticsRoutes;

beforeAll(async () => {
  ({ createAnalyticsRoutes } = await import("../routes"));
});

describe("analytics routes", () => {
  let analytics: FakeAnalytics & AnalyticsReads;
  let websites: FakeWebsiteQuery;
  let publicDashboard: FakePublicDashboard;
  let app: Hono;

  beforeEach(() => {
    analytics = makeAnalytics();
    websites = new FakeWebsiteQuery();
    publicDashboard = new FakePublicDashboard();
    websites.grant(WEBSITE, OWNER, "owner");
    websites.grant(WEBSITE, MEMBER, "member");

    app = new Hono();
    // Mounted at the base path the app uses, so the paths under test are the real ones.
    app.route("/api/v1/analytics", createAnalyticsRoutes({
      ...analyticsControllerServices(analytics),
      publicDashboard,
      websites,
      cfg: testConfig(),
    }));
  });

  function request(path: string, user?: string, init: RequestInit = {}) {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (user) headers["X-Test-User"] = user;
    return app.request(`/api/v1/analytics${path}`, { ...init, headers });
  }

  // ─── Access control, applied uniformly ────────────────────────────────────
  //
  // Driven off the route table rather than written out per endpoint. The point is
  // exhaustiveness: a route added later without a guard fails here automatically.

  describe("authentication", () => {
    for (const { path } of ALL_GUARDED_ROUTES) {
      it(`GET /${path} answers 401 without a token`, async () => {
        const res = await request(`/${path}/${WEBSITE}`);
        expect(res.status).toBe(401);
        expect(analytics.calls).toHaveLength(0);
      });
    }

    it("never reaches the analytics module for an anonymous request", async () => {
      for (const { path } of ALL_GUARDED_ROUTES) {
        await request(`/${path}/${WEBSITE}`);
      }
      expect(analytics.calls).toHaveLength(0);
      expect(websites.roleLookups).toHaveLength(0);
    });
  });

  describe("authorization", () => {
    for (const { path } of ALL_GUARDED_ROUTES) {
      it(`GET /${path} answers 403 for a user with no role on the site`, async () => {
        const res = await request(`/${path}/${WEBSITE}`, STRANGER);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden" });
        expect(analytics.calls).toHaveLength(0);
      });
    }

    it("answers an unknown website exactly as it answers a forbidden one", async () => {
      // Deliberate: a distinguishable 404 would turn these endpoints into an oracle for
      // which site ids exist. Status *and* body must match.
      const forbidden = await request(`/dashboard/${WEBSITE}`, STRANGER);
      const unknown = await request(`/dashboard/${UNKNOWN_WEBSITE}`, OWNER);

      expect(unknown.status).toBe(forbidden.status);
      expect(await unknown.json()).toEqual(await forbidden.json());
      expect(analytics.calls).toHaveLength(0);
    });

    it("admits a member, not just the owner", async () => {
      const res = await request(`/dashboard/${WEBSITE}`, MEMBER);
      expect(res.status).toBe(200);
      expect(analytics.callsTo("getDashboard")).toHaveLength(1);
    });

    it("checks the role against the website in the path and the caller's own id", async () => {
      await request(`/top-pages/${WEBSITE}`, MEMBER);
      expect(websites.roleLookups).toEqual([{ ref: WEBSITE, userId: MEMBER }]);
    });

    it("resolves the caller's role exactly once per request", async () => {
      // The guard is per-route; a second lookup would mean the check ran twice and
      // doubled the cost of the most-hit surface in the product.
      await request(`/dashboard/${WEBSITE}`, OWNER);
      expect(websites.roleLookups).toHaveLength(1);
    });
  });

  // ─── The shared query bag ─────────────────────────────────────────────────

  describe("windowed reads", () => {
    for (const { path, method } of WINDOWED_ROUTES) {
      it(`GET /${path} delegates to ${method} and returns its payload verbatim`, async () => {
        analytics.payload = { marker: path, nested: { rows: [1, 2, 3] } };
        const res = await request(`/${path}/${WEBSITE}`, OWNER);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ marker: path, nested: { rows: [1, 2, 3] } });
        expect(analytics.onlyCall().method).toBe(method);
      });

      it(`GET /${path} threads days, timezone and limit through untouched`, async () => {
        await request(`/${path}/${WEBSITE}?days=30&timezone=Asia/Dhaka&limit=25`, OWNER);
        expect(analytics.onlyCall().args).toEqual([
          WEBSITE,
          { days: "30", timezone: "Asia/Dhaka", limit: "25" },
        ]);
      });

      it(`GET /${path} passes undefined for parameters the client omitted`, async () => {
        // Not empty strings: the repositories branch on `undefined` to pick their own
        // per-endpoint default window, and "" would take a different branch.
        await request(`/${path}/${WEBSITE}`, OWNER);
        expect(analytics.onlyCall().args).toEqual([
          WEBSITE,
          { days: undefined, timezone: undefined, limit: undefined },
        ]);
      });
    }

    it("does not validate or clamp the shared bag at the HTTP layer", async () => {
      // Deliberate contract: `days` is clamped in the repository so a stale dashboard
      // URL renders the default range instead of erroring. The route must pass it on.
      const res = await request(`/dashboard/${WEBSITE}?days=99999`, OWNER);
      expect(res.status).toBe(200);
      expect(analytics.onlyCall().args[1]).toMatchObject({ days: "99999" });
    });

    it("forwards only the three recognised parameters, dropping the rest", async () => {
      await request(`/dashboard/${WEBSITE}?days=7&utm_source=evil&extra=1`, OWNER);
      expect(analytics.onlyCall().args[1]).toEqual({
        days: "7",
        timezone: undefined,
        limit: undefined,
      });
    });

    it("keeps the first value when a parameter is repeated", async () => {
      await request(`/dashboard/${WEBSITE}?days=7&days=30`, OWNER);
      expect(analytics.onlyCall().args[1]).toMatchObject({ days: "7" });
    });

    it("passes the website reference through without normalising it", async () => {
      websites.grant("site-abc", OWNER, "owner");
      await request(`/dashboard/site-abc`, OWNER);
      expect(analytics.onlyCall().args[0]).toBe("site-abc");
    });

    it("propagates a repository failure as a 500 rather than an empty 200", async () => {
      // A dashboard that renders zeroes because the query threw is worse than one that
      // reports an error, so this must not be swallowed into `c.json(undefined)`.
      analytics.throwOn = "getDashboard";
      const res = await request(`/dashboard/${WEBSITE}`, OWNER);
      expect(res.status).toBe(500);
    });
  });

  // ─── Realtime: fixed windows, no query bag ────────────────────────────────

  describe("GET /realtime/:website_id", () => {
    it("takes no options — the 30-minute window is fixed", async () => {
      await request(`/realtime/${WEBSITE}?days=30&limit=5&within_minutes=10`, OWNER);
      expect(analytics.onlyCall()).toEqual({ method: "getRealtime", args: [WEBSITE] });
    });
  });

  describe("GET /live-visitors/:website_id", () => {
    it("takes no options — both its windows are fixed", async () => {
      await request(`/live-visitors/${WEBSITE}?days=30`, OWNER);
      expect(analytics.onlyCall()).toEqual({ method: "getLiveVisitors", args: [WEBSITE] });
    });
  });

  describe("GET /recent-activity/:website_id", () => {
    it("defaults the limit to 50 and leaves the window unset", async () => {
      await request(`/recent-activity/${WEBSITE}`, OWNER);
      expect(analytics.onlyCall().args).toEqual([WEBSITE, 50, { withinMinutes: undefined }]);
    });

    it("coerces limit and within_minutes to numbers", async () => {
      await request(`/recent-activity/${WEBSITE}?limit=10&within_minutes=30`, OWNER);
      expect(analytics.onlyCall().args).toEqual([WEBSITE, 10, { withinMinutes: 30 }]);
    });

    it("accepts both ends of the limit range", async () => {
      await request(`/recent-activity/${WEBSITE}?limit=1`, OWNER);
      expect(analytics.onlyCall().args[1]).toBe(1);

      analytics.calls.length = 0;
      await request(`/recent-activity/${WEBSITE}?limit=100`, OWNER);
      expect(analytics.onlyCall().args[1]).toBe(100);
    });

    it("rejects a limit past the maximum with a field-level validation error", async () => {
      const res = await request(`/recent-activity/${WEBSITE}?limit=101`, OWNER);
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        issues?: { path: string[]; message: string }[];
      };
      expect(body.error).toBe("validation_error");
      expect(body.issues?.[0]?.path).toEqual(["limit"]);
      expect(analytics.calls).toHaveLength(0);
    });

    it("rejects a limit of zero, a negative limit, and a non-numeric limit", async () => {
      for (const limit of ["0", "-1", "abc"]) {
        analytics.calls.length = 0;
        const res = await request(`/recent-activity/${WEBSITE}?limit=${limit}`, OWNER);
        expect(res.status).toBe(400);
        expect(analytics.calls).toHaveLength(0);
      }
    });

    it("treats a blank limit as unspecified rather than invalid", async () => {
      // `?limit=` is what a URLSearchParams built from a partly-filled form emits.
      const res = await request(`/recent-activity/${WEBSITE}?limit=`, OWNER);
      expect(res.status).toBe(200);
      expect(analytics.onlyCall().args[1]).toBe(50);
    });

    it("accepts both ends of the within_minutes range and rejects outside it", async () => {
      await request(`/recent-activity/${WEBSITE}?within_minutes=1`, OWNER);
      expect(analytics.onlyCall().args[2]).toEqual({ withinMinutes: 1 });

      analytics.calls.length = 0;
      await request(`/recent-activity/${WEBSITE}?within_minutes=1440`, OWNER);
      expect(analytics.onlyCall().args[2]).toEqual({ withinMinutes: 1440 });

      for (const v of ["0", "1441", "-5"]) {
        const res = await request(`/recent-activity/${WEBSITE}?within_minutes=${v}`, OWNER);
        expect(res.status).toBe(400);
      }
    });

    it("checks access before validating — a stranger cannot probe the schema", async () => {
      // Order matters: a 400 for a caller who is not allowed to read the site at all
      // would confirm the site exists and reveal the parameter contract.
      const res = await request(`/recent-activity/${WEBSITE}?limit=99999`, STRANGER);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /realtime-geo/:website_id", () => {
    it("passes no options at all when within_minutes is unset", async () => {
      // Not `{ withinMinutes: undefined }`: the repository defaults on `opts?.withinMinutes`,
      // and an explicit undefined inside an object is indistinguishable there — but the
      // route's own contract is to omit the argument, which this pins down.
      await request(`/realtime-geo/${WEBSITE}`, OWNER);
      expect(analytics.onlyCall().args).toEqual([WEBSITE, undefined]);
    });

    it("passes the window when set", async () => {
      await request(`/realtime-geo/${WEBSITE}?within_minutes=60`, OWNER);
      expect(analytics.onlyCall().args).toEqual([WEBSITE, { withinMinutes: 60 }]);
    });

    it("rejects an out-of-range window", async () => {
      const res = await request(`/realtime-geo/${WEBSITE}?within_minutes=5000`, OWNER);
      expect(res.status).toBe(400);
      expect(analytics.calls).toHaveLength(0);
    });

    it("ignores a limit parameter — the endpoint returns the whole breakdown", async () => {
      await request(`/realtime-geo/${WEBSITE}?limit=3`, OWNER);
      expect(analytics.onlyCall().args).toEqual([WEBSITE, undefined]);
    });
  });

  // ─── The public share link ────────────────────────────────────────────────

  describe("GET /public/dashboard/:public_id", () => {
    it("answers without any credentials — that is the point of a share link", async () => {
      const res = await app.request("/api/v1/analytics/public/dashboard/share_abc");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ website_id: WEBSITE, page_views: 5 });
    });

    it("never consults the membership table", async () => {
      await app.request("/api/v1/analytics/public/dashboard/share_abc");
      expect(websites.roleLookups).toHaveLength(0);
    });

    it("threads the shared query bag", async () => {
      await app.request("/api/v1/analytics/public/dashboard/share_abc?days=30&timezone=UTC");
      expect(publicDashboard.calls[0]).toEqual({
        publicId: "share_abc",
        query: { days: "30", timezone: "UTC", limit: undefined },
      });
    });

    it("answers 404 for an unknown or revoked link", async () => {
      publicDashboard.result = null;
      const res = await app.request("/api/v1/analytics/public/dashboard/revoked");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    });

    it("is not shadowed by the authenticated /dashboard/:website_id route", async () => {
      // `/public/dashboard/x` and `/dashboard/x` are distinct prefixes; a routing
      // regression that merged them would make the share link demand a token.
      const res = await app.request("/api/v1/analytics/public/dashboard/share_abc");
      expect(res.status).toBe(200);
      expect(analytics.calls).toHaveLength(0);
    });

    it("still requires a token on the authenticated dashboard route", async () => {
      const res = await app.request(`/api/v1/analytics/dashboard/${WEBSITE}`);
      expect(res.status).toBe(401);
    });
  });

  // ─── Import ───────────────────────────────────────────────────────────────

  describe("POST /import", () => {
    it("requires a token", async () => {
      const res = await app.request("/api/v1/analytics/import", {
        method: "POST",
        body: JSON.stringify({ rows: [] }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts a well-formed body", async () => {
      const res = await request("/import", OWNER, {
        method: "POST",
        body: JSON.stringify({ rows: [{ page: "/" }] }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("drains an unparseable body instead of hanging on the stream", async () => {
      const res = await request("/import", OWNER, {
        method: "POST",
        body: "not json at all",
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("accepts an empty body", async () => {
      const res = await request("/import", OWNER, { method: "POST" });
      expect(res.status).toBe(200);
    });

    it("writes nothing — the endpoint is accepted-but-unimplemented", async () => {
      await request("/import", OWNER, {
        method: "POST",
        body: JSON.stringify({ rows: [{ page: "/" }] }),
        headers: { "content-type": "application/json" },
      });
      expect(analytics.calls).toHaveLength(0);
    });
  });

  // ─── Method and shape guards ──────────────────────────────────────────────

  describe("HTTP method handling", () => {
    it("does not answer POST on a read route", async () => {
      const res = await request(`/dashboard/${WEBSITE}`, OWNER, { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("answers 404 for an unregistered path rather than falling through to a guard", async () => {
      const res = await request(`/not-a-real-endpoint/${WEBSITE}`, OWNER);
      expect(res.status).toBe(404);
      expect(analytics.calls).toHaveLength(0);
    });

    it("answers JSON on every read route", async () => {
      for (const { path } of WINDOWED_ROUTES) {
        const res = await request(`/${path}/${WEBSITE}`, OWNER);
        expect(res.headers.get("content-type")).toContain("application/json");
      }
    });
  });

  // ─── Coverage: the route table above must match the router ────────────────

  describe("route coverage", () => {
    /** Paths this file actually exercises, in the router's own `/:segment/...` form. */
    function testedPaths(): Set<string> {
      const set = new Set<string>();
      for (const { path } of ALL_GUARDED_ROUTES) set.add(`GET /${path}/:website_id`);
      set.add("GET /public/dashboard/:public_id");
      set.add("POST /import");
      return set;
    }

    it("exercises every route the factory registers", async () => {
      // The guard against a new endpoint shipping untested — and, more importantly,
      // shipping unguarded, since the 401/403 sweeps above are driven off the same table.
      const registered = new Set(
        createAnalyticsRoutes({
          ...analyticsControllerServices(analytics),
          publicDashboard,
          websites,
          cfg: testConfig(),
        })
          .routes.filter((r) => r.method !== "ALL")
          .map((r) => `${r.method} ${r.path}`),
      );
      const tested = testedPaths();

      const untested = [...registered].filter((r) => !tested.has(r));
      expect(untested).toEqual([]);
    });

    it("does not claim coverage of routes that no longer exist", async () => {
      const registered = new Set(
        createAnalyticsRoutes({
          ...analyticsControllerServices(analytics),
          publicDashboard,
          websites,
          cfg: testConfig(),
        })
          .routes.filter((r) => r.method !== "ALL")
          .map((r) => `${r.method} ${r.path}`),
      );
      const stale = [...testedPaths()].filter((r) => !registered.has(r));
      expect(stale).toEqual([]);
    });
  });
});
