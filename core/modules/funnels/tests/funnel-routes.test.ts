import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Website, WebsiteQuery, WebsiteRole } from "../../websites/interfaces";
import type {
  CreateFunnelInput,
  Funnel,
  FunnelMutations,
  FunnelPerformance,
  FunnelQuery,
  FunnelReport,
  FunnelTrackerConfig,
  UpdateFunnelInput,
} from "../interfaces";

// ─── Mocks — must be declared before the dynamic import below ────────────────
//
// Only the JWT middleware is faked: everything else the routes touch (the shared
// validators, the logger) is real, and the module under test reaches no database at
// all. `X-Test-User` stands in for a verified token so the guard's 401 and 403 paths
// can be exercised independently.

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

const WEBSITE_UUID = "11111111-1111-4111-8111-111111111111";
const OWNER = "user_1";

function makeWebsite(): Website {
  return {
    id: WEBSITE_UUID,
    ownerId: OWNER,
    name: "One",
    url: "one.example",
    trackingId: "ST-0001",
    isActive: true,
    isVerified: true,
    automationEnabled: true,
    funnelEnabled: true,
    heatmapEnabled: true,
    heatmapIncludePatterns: null,
    heatmapExcludePatterns: null,
    heatmapLayoutEnabled: true,
    replayEnabled: true,
    replaySamplingRate: 1,
    replayIncludePatterns: null,
    replayExcludePatterns: null,
    verificationToken: "tok",
    publicShareId: null,
    settings: {
      allowedOrigins: [],
      trackingEnabled: true,
      dataRetentionDays: 365,
      useIpAnonymization: false,
      respectDoNotTrack: false,
      allowRawDataExport: false,
    },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function makeFunnel(overrides: Partial<Funnel> = {}): Funnel {
  return {
    id: "fn_1",
    website_id: WEBSITE_UUID,
    user_id: OWNER,
    name: "Checkout",
    description: "",
    is_active: true,
    steps: [
      { id: "s0", name: "View", order: 0, step_type: "page_view", match_type: "exact" },
    ],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    stats: {
      totalEntries: 0,
      completions: 0,
      conversionRate: 0,
      stepBreakdown: [{ stepOrder: 0, count: 0, dropoffCount: 0, dropoffRate: 0 }],
    },
    ...overrides,
  };
}

/** Controller-facing website access and public tracker lookup. */
class FakeWebsiteQuery implements WebsiteQuery {
  roles = new Map<string, WebsiteRole>();

  grant(websiteRef: string, userId: string, role: WebsiteRole): void {
    this.roles.set(`${websiteRef}:${userId}`, role);
  }

  async getRole(websiteRef: string, userId: string): Promise<WebsiteRole | null> {
    return this.roles.get(`${websiteRef}:${userId}`) ?? null;
  }

  async getById(websiteId: string): Promise<Website | null> {
    return websiteId === WEBSITE_UUID ? makeWebsite() : null;
  }

  async listOwnedBy(): Promise<Website[]> {
    throw new Error("unused");
  }
}

/** In-memory funnels module. Records calls so argument threading is assertable. */
class FakeFunnels
  implements FunnelQuery, FunnelMutations, FunnelPerformance, FunnelTrackerConfig
{
  funnels: Funnel[] = [makeFunnel()];
  report_: FunnelReport | null = {
    totalEntries: 10,
    completions: 4,
    conversionRate: 40,
    stepBreakdown: [
      { stepOrder: 0, stepName: "View", count: 10, dropoffCount: 0, dropoffRate: 0 },
    ],
  };
  reportArgs: { websiteRef: string; funnelId: string; days: number | undefined }[] = [];
  created: { websiteRef: string; userId: string; input: CreateFunnelInput }[] = [];
  updated: { funnelId: string; input: UpdateFunnelInput }[] = [];
  removed: string[] = [];
  bulkRemoved: string[][] = [];
  activeRefs: string[] = [];
  throwOn: string | null = null;

  private guard(op: string) {
    if (this.throwOn === op) throw new Error("boom");
  }

  async list(_websiteRef: string): Promise<Funnel[]> {
    this.guard("list");
    return this.funnels;
  }

  async get(_websiteRef: string, funnelId: string): Promise<Funnel | null> {
    this.guard("get");
    return this.funnels.find((f) => f.id === funnelId) ?? null;
  }

  async create(websiteRef: string, userId: string, input: CreateFunnelInput): Promise<Funnel> {
    this.guard("create");
    this.created.push({ websiteRef, userId, input });
    return makeFunnel({ id: "fn_new", name: input.name });
  }

  async update(
    _websiteRef: string,
    funnelId: string,
    input: UpdateFunnelInput,
  ): Promise<Funnel | null> {
    this.guard("update");
    this.updated.push({ funnelId, input });
    return this.funnels.find((f) => f.id === funnelId) ?? null;
  }

  async remove(_websiteRef: string, funnelId: string): Promise<void> {
    this.guard("remove");
    this.removed.push(funnelId);
  }

  async bulkRemove(_websiteRef: string, funnelIds: string[]): Promise<void> {
    this.guard("bulkRemove");
    this.bulkRemoved.push(funnelIds);
  }

  async report(
    websiteRef: string,
    funnelId: string,
    days?: number | undefined,
  ): Promise<FunnelReport | null> {
    this.guard("report");
    this.reportArgs.push({ websiteRef, funnelId, days });
    return this.report_;
  }

  async activeForTracker(websiteId: string): Promise<Funnel[]> {
    this.activeRefs.push(websiteId);
    return this.funnels.filter((f) => f.is_active);
  }
}

// ─── Load the factory after the mocks ────────────────────────────────────────

let createFunnelRoutes: typeof import("../routes").createFunnelRoutes;

beforeAll(async () => {
  ({ createFunnelRoutes } = await import("../routes"));
});

describe("funnel routes", () => {
  let funnels: FakeFunnels;
  let websites: FakeWebsiteQuery;
  let app: Hono;

  /** Mounted at the same base paths `index.ts` uses, so the paths under test are real. */
  beforeEach(() => {
    funnels = new FakeFunnels();
    websites = new FakeWebsiteQuery();
    websites.grant(WEBSITE_UUID, OWNER, "owner");

    const routes = createFunnelRoutes({
      definitions: funnels,
      performance: funnels,
      trackerConfig: funnels,
      websites,
    });
    app = new Hono();
    app.route("/api/v1/funnels", routes.publicRoutes);
    app.route("/api/v1/websites", routes.authRoutes);
  });

  function asOwner(path: string, init: RequestInit = {}) {
    return app.request(path, {
      ...init,
      headers: { "X-Test-User": OWNER, ...(init.headers as Record<string, string>) },
    });
  }

  describe("GET /api/v1/funnels/active (public)", () => {
    it("returns active funnels under `data` with no credentials", async () => {
      const res = await app.request(`/api/v1/funnels/active?website_id=${WEBSITE_UUID}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: funnels.funnels });
    });

    // The tracker has shipped both spellings over time.
    it("accepts the camelCase parameter too", async () => {
      const res = await app.request(`/api/v1/funnels/active?websiteId=${WEBSITE_UUID}`);
      expect(res.status).toBe(200);
      expect(funnels.activeRefs).toEqual([WEBSITE_UUID]);
    });

    // Flat `{ error }`, not the validator's field-error map — the tracker only
    // looks for `error`.
    it("answers 400 with a flat error when the parameter is missing", async () => {
      const res = await app.request("/api/v1/funnels/active");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "website_id required" });
    });
  });

  describe("authentication", () => {
    it("answers 401 without a token", async () => {
      const res = await app.request(`/api/v1/websites/${WEBSITE_UUID}/funnels`);
      expect(res.status).toBe(401);
    });
  });

  describe("authorization", () => {
    it("answers 403 for a user with no role on the website", async () => {
      const res = await app.request(`/api/v1/websites/${WEBSITE_UUID}/funnels`, {
        headers: { "X-Test-User": "stranger" },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    });

    // Unknown and forbidden are deliberately indistinguishable, so the endpoint
    // cannot be used to enumerate which website ids exist.
    it("answers 403 for an unknown website, not 404", async () => {
      const res = await asOwner("/api/v1/websites/does-not-exist/funnels");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    });

    it("guards writes as well as reads", async () => {
      const paths: [string, string][] = [
        ["POST", `/api/v1/websites/${WEBSITE_UUID}/funnels`],
        ["PUT", `/api/v1/websites/${WEBSITE_UUID}/funnels/fn_1`],
        ["DELETE", `/api/v1/websites/${WEBSITE_UUID}/funnels/fn_1`],
        ["DELETE", `/api/v1/websites/${WEBSITE_UUID}/funnels/bulk-delete`],
        ["GET", `/api/v1/websites/${WEBSITE_UUID}/funnels/fn_1/stats`],
      ];

      for (const [method, path] of paths) {
        const res = await app.request(path, {
          method,
          headers: { "X-Test-User": "stranger", "Content-Type": "application/json" },
          body: method === "GET" || method === "DELETE" ? undefined : "{}",
        });
        expect(res.status).toBe(403);
      }

      expect(funnels.created).toEqual([]);
      expect(funnels.removed).toEqual([]);
    });
  });

  describe("list and get", () => {
    it("wraps the list in `data`", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: funnels.funnels });
    });

    it("wraps one funnel in `data`", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/fn_1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: funnels.funnels[0] });
    });

    it("answers 404 for a funnel that does not exist", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/missing`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    });
  });

  describe("create", () => {
    it("answers 201 with the funnel under `data`", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New", steps: [{ name: "A" }] }),
      });

      expect(res.status).toBe(201);
      expect((await res.json()).data.name).toBe("New");
      expect(funnels.created[0]).toMatchObject({ websiteRef: WEBSITE_UUID, userId: OWNER });
    });

    // The body schema is an open record on purpose, so unknown keys from an older
    // builder bundle must reach the service rather than being rejected or stripped.
    it("passes unrecognised body keys through untouched", async () => {
      await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New", legacyField: 7 }),
      });

      expect(funnels.created[0]?.input).toMatchObject({ name: "New", legacyField: 7 });
    });

    it("rejects a non-object body", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "[]",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("update", () => {
    it("answers 200 with the funnel under `data`", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/fn_1`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });

      expect(res.status).toBe(200);
      expect(funnels.updated).toEqual([{ funnelId: "fn_1", input: { name: "Renamed" } }]);
    });

    it("answers 404 when nothing matched", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/missing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("delete", () => {
    it("answers 204 with an empty body", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/fn_1`, {
        method: "DELETE",
      });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(funnels.removed).toEqual(["fn_1"]);
    });

    it("answers 204 for a funnel that was already gone", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/missing`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
    });
  });

  describe("bulk delete", () => {
    // Registered before `/:funnel_id`, so `bulk-delete` must not be captured as a
    // funnel id. This is the test that fails if the route order is ever shuffled.
    it("is matched as a bulk delete, not as a funnel id", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/bulk-delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["a", "b"] }),
      });

      expect(res.status).toBe(204);
      expect(funnels.bulkRemoved).toEqual([["a", "b"]]);
      expect(funnels.removed).toEqual([]);
    });

    it("defaults a missing `ids` to an empty batch", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/bulk-delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(204);
      expect(funnels.bulkRemoved).toEqual([[]]);
    });

    it("rejects a malformed body", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/bulk-delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [""] }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("stats", () => {
    it("wraps the report in `data`", async () => {
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/fn_1/stats`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: funnels.report_ });
    });

    it("answers 404 for a funnel that does not exist", async () => {
      funnels.report_ = null;
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/missing/stats`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    });

    it("forwards `days` as a number", async () => {
      await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/fn_1/stats?days=7`);
      expect(funnels.reportArgs[0]?.days).toBe(7);
    });

    it("omits `days` when absent so the service applies its default", async () => {
      await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels/fn_1/stats`);
      expect(funnels.reportArgs[0]?.days).toBeUndefined();
    });

    // A stale bookmark should render the default window, not a 400 — so the route
    // forwards the unparseable value and lets the service clamp it.
    it("forwards an unparseable `days` rather than rejecting the request", async () => {
      const res = await asOwner(
        `/api/v1/websites/${WEBSITE_UUID}/funnels/fn_1/stats?days=last-month`,
      );
      expect(res.status).toBe(200);
      expect(funnels.reportArgs[0]?.days).toBeNaN();
    });
  });

  describe("unexpected failures", () => {
    // Logged with detail, answered generically — never surfaced as a 403, which is
    // what the previous catch-all did and made an outage look like a permissions bug.
    it("answers 500 when the service throws", async () => {
      funnels.throwOn = "list";
      const res = await asOwner(`/api/v1/websites/${WEBSITE_UUID}/funnels`);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to process funnel request" });
    });
  });
});
