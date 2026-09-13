import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Website, WebsiteQuery, WebsiteRole } from "../../websites/interfaces";
import type {
  AutomationCrud,
  AutomationDailyRuns,
  AutomationExecutionRow,
  AutomationInsights,
  AutomationListItem,
  AutomationRow,
  AutomationStats,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "../interfaces";

/**
 * The automations HTTP surface.
 *
 * Two things here are load-bearing beyond the usual guard checks. The write routes
 * carry webhook URLs and headers, so the schema they validate against is a security
 * boundary rather than a convenience — a definition that reaches storage is a
 * definition the evaluation path will later fetch and call. And `/bulk-delete` is
 * registered before `/:id`, which means the route table's *order* is behaviour: swap
 * them and "bulk-delete" becomes an automation id.
 */

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
const UNKNOWN_WEBSITE = "22222222-2222-4222-8222-222222222222";
const OWNER = "user_owner";
const MEMBER = "user_member";
const STRANGER = "user_stranger";
const AUTOMATION = "auto_1";

/** A webhook URL the SSRF allow-list accepts, and one it must not. */
const SAFE_WEBHOOK = "https://hooks.example.com/inbound";
const INTERNAL_WEBHOOK = "http://169.254.169.254/latest/meta-data/";

/** The smallest definition the schema accepts: one trigger, a one-node graph. */
function definition(over: Record<string, unknown> = {}) {
  return {
    triggers: [{ type: "exit_intent" }],
    graph: { entry: "a", nodes: [{ id: "a", kind: "action", action: { type: "show_banner" } }], edges: [] },
    ...over,
  };
}

/** A one-node graph wrapping a single action, for the webhook cases below. */
const graphOf = (action: Record<string, unknown>) => ({
  entry: "a",
  nodes: [{ id: "a", kind: "action", action }],
  edges: [] as unknown[],
});

function makeRow(over: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: AUTOMATION,
    websiteId: WEBSITE,
    userId: OWNER,
    name: "Exit intent banner",
    definition: { trigger: { type: "exit_intent" }, actions: [] },
    isActive: true,
    priority: 0,
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

function makeStats(): AutomationStats {
  return { totalExecutions: 10, successCount: 9, failureCount: 1, successRate: 90, last30Days: 4 };
}

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
    throw new Error("routes must not resolve websites themselves");
  }

  async listOwnedBy(): Promise<Website[]> {
    throw new Error("unused");
  }
}

/** In-memory automations module. Records calls so argument threading is assertable. */
class FakeAutomations implements AutomationCrud, AutomationInsights {
  rows: AutomationRow[] = [makeRow()];
  created: Array<{ websiteRef: string; userId: string; input: CreateAutomationInput }> = [];
  updated: Array<{ automationId: string; patch: UpdateAutomationInput }> = [];
  removed: string[] = [];
  bulkRemoved: string[][] = [];
  toggled: string[] = [];
  missing = false;

  async list(websiteRef: string): Promise<AutomationListItem[]> {
    return this.rows.map((r) => ({
      id: r.id,
      website_id: websiteRef,
      name: r.name,
      definition: r.definition,
      is_active: r.isActive,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
      stats: makeStats(),
    }));
  }

  async create(
    websiteRef: string,
    userId: string,
    input: CreateAutomationInput,
  ): Promise<AutomationRow> {
    this.created.push({ websiteRef, userId, input });
    return makeRow({ id: "auto_new", name: input.name });
  }

  async get(_websiteRef: string, automationId: string): Promise<AutomationRow | null> {
    if (this.missing) return null;
    return this.rows.find((r) => r.id === automationId) ?? null;
  }

  async update(
    _websiteRef: string,
    automationId: string,
    patch: UpdateAutomationInput,
  ): Promise<AutomationRow | null> {
    this.updated.push({ automationId, patch });
    return this.missing ? null : makeRow({ id: automationId });
  }

  async remove(_websiteRef: string, automationId: string): Promise<void> {
    this.removed.push(automationId);
  }

  async bulkDelete(_websiteRef: string, automationIds: string[]): Promise<void> {
    this.bulkRemoved.push(automationIds);
  }

  async toggle(_websiteRef: string, automationId: string): Promise<AutomationRow | null> {
    this.toggled.push(automationId);
    return this.missing ? null : makeRow({ id: automationId, isActive: false });
  }

  async executions(): Promise<AutomationExecutionRow[] | null> {
    return this.missing ? null : [];
  }

  async stats(): Promise<AutomationStats | null> {
    return this.missing ? null : makeStats();
  }

  async dailyStats(): Promise<AutomationDailyRuns[] | null> {
    return this.missing
      ? null
      : Array.from({ length: 14 }, (_, i) => ({ day: `D${i + 1}`, runs: i }));
  }
}

// ─── Load the factory after the mocks ────────────────────────────────────────

let createAutomationRoutes: typeof import("../routes").createAutomationRoutes;

beforeAll(async () => {
  ({ createAutomationRoutes } = await import("../routes"));
});

describe("automation routes", () => {
  let automations: FakeAutomations;
  let websites: FakeWebsiteQuery;
  let app: Hono;

  beforeEach(() => {
    automations = new FakeAutomations();
    websites = new FakeWebsiteQuery();
    websites.grant(WEBSITE, OWNER, "owner");
    websites.grant(WEBSITE, MEMBER, "member");

    app = new Hono();
    app.route("/api/v1/automations", createAutomationRoutes({
      automationCrud: automations,
      automationInsights: automations,
      websites,
    }));
  });

  function request(path: string, user?: string, init: RequestInit = {}) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(init.headers as Record<string, string>),
    };
    if (user) headers["X-Test-User"] = user;
    return app.request(`/api/v1/automations${path}`, { ...init, headers });
  }

  /** Every route, as (method, path) pairs — drives the guard sweeps below. */
  const ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
    { method: "GET", path: `/${WEBSITE}` },
    { method: "POST", path: `/${WEBSITE}`, body: { name: "x", definition: definition() } },
    { method: "DELETE", path: `/${WEBSITE}/bulk-delete`, body: { ids: [] } },
    { method: "GET", path: `/${WEBSITE}/${AUTOMATION}` },
    { method: "PUT", path: `/${WEBSITE}/${AUTOMATION}`, body: { name: "x" } },
    { method: "DELETE", path: `/${WEBSITE}/${AUTOMATION}` },
    { method: "GET", path: `/${WEBSITE}/${AUTOMATION}/executions` },
    { method: "POST", path: `/${WEBSITE}/${AUTOMATION}/toggle` },
    { method: "GET", path: `/${WEBSITE}/${AUTOMATION}/stats` },
    { method: "GET", path: `/${WEBSITE}/${AUTOMATION}/stats/daily` },
  ];

  function send(route: (typeof ROUTES)[number], user?: string) {
    return request(route.path, user, {
      method: route.method,
      ...(route.body ? { body: JSON.stringify(route.body) } : {}),
    });
  }

  // ─── Access control ───────────────────────────────────────────────────────

  describe("authentication", () => {
    for (const route of ROUTES) {
      it(`${route.method} ${route.path.replace(WEBSITE, ":website_id")} answers 401 without a token`, async () => {
        const res = await send(route);
        expect(res.status).toBe(401);
      });
    }

    it("never reaches the automations module for an anonymous request", async () => {
      for (const route of ROUTES) await send(route);
      expect(automations.created).toHaveLength(0);
      expect(automations.removed).toHaveLength(0);
      expect(websites.roleLookups).toHaveLength(0);
    });
  });

  describe("authorization", () => {
    for (const route of ROUTES) {
      it(`${route.method} ${route.path.replace(WEBSITE, ":website_id")} answers 403 for a stranger`, async () => {
        const res = await send(route, STRANGER);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden" });
      });
    }

    it("guards the write routes as well as the reads", async () => {
      // An automation definition holds webhook URLs and headers, so create/update are
      // the routes where a missing check matters most.
      await request(`/${WEBSITE}`, STRANGER, {
        method: "POST",
        body: JSON.stringify({
          name: "x",
          definition: definition({ graph: graphOf({ type: "webhook", url: SAFE_WEBHOOK }) }),
        }),
      });
      await request(`/${WEBSITE}/${AUTOMATION}`, STRANGER, { method: "DELETE" });

      expect(automations.created).toHaveLength(0);
      expect(automations.removed).toHaveLength(0);
    });

    it("answers an unknown website exactly as it answers a forbidden one", async () => {
      const forbidden = await request(`/${WEBSITE}`, STRANGER);
      const unknown = await request(`/${UNKNOWN_WEBSITE}`, OWNER);
      expect(unknown.status).toBe(forbidden.status);
      expect(await unknown.json()).toEqual(await forbidden.json());
    });

    it("admits a member, not just the owner", async () => {
      expect((await request(`/${WEBSITE}`, MEMBER)).status).toBe(200);
    });

    it("resolves the caller's role exactly once per request", async () => {
      await request(`/${WEBSITE}`, OWNER);
      expect(websites.roleLookups).toEqual([{ ref: WEBSITE, userId: OWNER }]);
    });
  });

  // ─── Read routes ──────────────────────────────────────────────────────────

  describe("GET /:website_id", () => {
    it("wraps the list in `data` with stats embedded per row", async () => {
      const res = await request(`/${WEBSITE}`, OWNER);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: AutomationListItem[] };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ id: AUTOMATION, is_active: true });
      expect(body.data[0]!.stats).toEqual(makeStats());
    });

    it("returns the list in snake_case — the shape the dashboard parses", async () => {
      const body = (await (await request(`/${WEBSITE}`, OWNER)).json()) as {
        data: Record<string, unknown>[];
      };
      expect(Object.keys(body.data[0]!).sort()).toEqual([
        "created_at",
        "definition",
        "id",
        "is_active",
        "name",
        "stats",
        "updated_at",
        "website_id",
      ]);
    });

    it("answers an empty list, not a 404, for a website with no automations", async () => {
      automations.rows = [];
      const res = await request(`/${WEBSITE}`, OWNER);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [] });
    });
  });

  describe("GET /:website_id/:id", () => {
    it("wraps the camelCase row in `data`", async () => {
      const body = (await (await request(`/${WEBSITE}/${AUTOMATION}`, OWNER)).json()) as {
        data: Record<string, unknown>;
      };
      // Deliberate asymmetry with the list route; both shapes are live contracts.
      expect(body.data).toMatchObject({ id: AUTOMATION, websiteId: WEBSITE, isActive: true });
    });

    it("answers 404 for an automation this website does not own", async () => {
      automations.missing = true;
      const res = await request(`/${WEBSITE}/${AUTOMATION}`, OWNER);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    });
  });

  describe("insight routes", () => {
    it("returns the execution log wrapped in `data`", async () => {
      const res = await request(`/${WEBSITE}/${AUTOMATION}/executions`, OWNER);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [] });
    });

    it("returns lifetime counters wrapped in `data`", async () => {
      const body = await (await request(`/${WEBSITE}/${AUTOMATION}/stats`, OWNER)).json();
      expect(body).toEqual({ data: makeStats() });
    });

    it("returns fourteen daily buckets, oldest first", async () => {
      const body = (await (
        await request(`/${WEBSITE}/${AUTOMATION}/stats/daily`, OWNER)
      ).json()) as { data: AutomationDailyRuns[] };
      expect(body.data).toHaveLength(14);
      expect(body.data[0]!.day).toBe("D1");
      expect(body.data[13]!.day).toBe("D14");
    });

    it("distinguishes a missing automation from all-zero counters", async () => {
      // `null` from the service is a 404; zeroed counters are a 200. Collapsing them
      // would make a deleted automation look like one that never ran.
      automations.missing = true;
      for (const path of ["/executions", "/stats", "/stats/daily"]) {
        const res = await request(`/${WEBSITE}/${AUTOMATION}${path}`, OWNER);
        expect(res.status).toBe(404);
      }
    });

    it("does not let /stats/daily be captured by the /:id route", async () => {
      const res = await request(`/${WEBSITE}/${AUTOMATION}/stats/daily`, OWNER);
      const body = (await res.json()) as { data: unknown[] };
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // ─── Create ───────────────────────────────────────────────────────────────

  describe("POST /:website_id", () => {
    it("answers 201 with the created row and records the caller as its owner", async () => {
      const res = await request(`/${WEBSITE}`, OWNER, {
        method: "POST",
        body: JSON.stringify({ name: "Welcome banner", definition: definition() }),
      });
      expect(res.status).toBe(201);

      expect(automations.created).toHaveLength(1);
      expect(automations.created[0]).toMatchObject({ websiteRef: WEBSITE, userId: OWNER });
    });

    it("accepts a webhook action pointing at a public https endpoint", async () => {
      const res = await request(`/${WEBSITE}`, OWNER, {
        method: "POST",
        body: JSON.stringify({
          name: "Notify",
          definition: definition({ graph: graphOf({ type: "webhook", url: SAFE_WEBHOOK, method: "POST" }) }),
        }),
      });
      expect(res.status).toBe(201);
    });

    it("rejects a webhook aimed at an internal address", async () => {
      // The cloud metadata endpoint is the canonical SSRF target: an automation that
      // reaches it exfiltrates instance credentials on every trigger.
      const res = await request(`/${WEBSITE}`, OWNER, {
        method: "POST",
        body: JSON.stringify({
          name: "Exfiltrate",
          definition: definition({ graph: graphOf({ type: "webhook", url: INTERNAL_WEBHOOK }) }),
        }),
      });
      expect(res.status).toBe(400);
      expect(automations.created).toHaveLength(0);
    });

    it("rejects a webhook that sets a forbidden header", async () => {
      for (const header of ["Authorization", "cookie", "Host"]) {
        const res = await request(`/${WEBSITE}`, OWNER, {
          method: "POST",
          body: JSON.stringify({
            name: "Sneaky",
            definition: definition({
              graph: graphOf({ type: "webhook", url: SAFE_WEBHOOK, headers: { [header]: "x" } }),
            }),
          }),
        });
        expect(res.status).toBe(400);
      }
      expect(automations.created).toHaveLength(0);
    });

    it("rejects an unsupported HTTP method on a webhook action", async () => {
      const res = await request(`/${WEBSITE}`, OWNER, {
        method: "POST",
        body: JSON.stringify({
          name: "Odd",
          definition: definition({ graph: graphOf({ type: "webhook", url: SAFE_WEBHOOK, method: "TRACE" }) }),
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a graph with more nodes than the cap", async () => {
      const nodes = Array.from({ length: 101 }, (_, i) => ({
        id: `n${i}`,
        kind: "action",
        action: { type: "show_banner" },
      }));
      const res = await request(`/${WEBSITE}`, OWNER, {
        method: "POST",
        body: JSON.stringify({
          name: "Too many",
          definition: definition({ graph: { entry: "n0", nodes, edges: [] } }),
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a graph whose connections form a loop", async () => {
      const res = await request(`/${WEBSITE}`, OWNER, {
        method: "POST",
        body: JSON.stringify({
          name: "Looping",
          definition: definition({
            graph: {
              entry: "a",
              nodes: [
                { id: "a", kind: "action", action: { type: "show_banner" } },
                { id: "b", kind: "action", action: { type: "show_toast" } },
              ],
              edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
            },
          }),
        }),
      });
      expect(res.status).toBe(400);
      expect(automations.created).toHaveLength(0);
    });

    it("rejects a definition with no trigger", async () => {
      const res = await request(`/${WEBSITE}`, OWNER, {
        method: "POST",
        body: JSON.stringify({ name: "Triggerless", definition: definition({ triggers: [] }) }),
      });
      expect(res.status).toBe(400);
      expect(automations.created).toHaveLength(0);
    });

    it("rejects a graph with a branch wired to nothing", async () => {
      const res = await request(`/${WEBSITE}`, OWNER, {
        method: "POST",
        body: JSON.stringify({
          name: "Dangling",
          definition: definition({
            graph: {
              entry: "if1",
              nodes: [
                { id: "if1", kind: "if", group: { operator: "AND", rules: [{ fact: "x", operator: "isSet" }] } },
                { id: "a", kind: "action", action: { type: "show_banner" } },
              ],
              edges: [{ from: "if1", to: "a", branch: "true" }],
            },
          }),
        }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts a branching graph whose paths converge", async () => {
      const res = await request(`/${WEBSITE}`, OWNER, {
        method: "POST",
        body: JSON.stringify({
          name: "Branching",
          definition: definition({
            graph: {
              entry: "if1",
              nodes: [
                { id: "if1", kind: "if", group: { operator: "AND", rules: [{ fact: "page", operator: "isSet" }] } },
                { id: "yes", kind: "action", action: { type: "show_banner" } },
                { id: "no", kind: "action", action: { type: "show_toast" } },
                { id: "d", kind: "delay", seconds: 5 },
                { id: "tail", kind: "action", action: { type: "redirect" } },
              ],
              edges: [
                { from: "if1", to: "yes", branch: "true" },
                { from: "if1", to: "no", branch: "false" },
                { from: "yes", to: "d" },
                { from: "no", to: "d" },
                { from: "d", to: "tail" },
              ],
            },
          }),
        }),
      });
      expect(res.status).toBe(201);
    });

    it("rejects an empty or over-long name", async () => {
      for (const name of ["", "n".repeat(201)]) {
        const res = await request(`/${WEBSITE}`, OWNER, {
          method: "POST",
          body: JSON.stringify({ name, definition: definition() }),
        });
        expect(res.status).toBe(400);
      }
    });

    it("threads frequency caps and A/B configuration through to the service", async () => {
      await request(`/${WEBSITE}`, OWNER, {
        method: "POST",
        body: JSON.stringify({
          name: "Rich",
          definition: definition({
            frequency: { maxPerSession: 1 },
            abTest: { enabled: true, variants: [{ id: "a", weight: 1 }] },
          }),
        }),
      });
      expect(automations.created[0]!.input).toMatchObject({
        definition: {
          frequency: { maxPerSession: 1 },
          abTest: { enabled: true, variants: [{ id: "a", weight: 1 }] },
        },
      });
    });

    it("answers a malformed JSON body with the schema's issue list", async () => {
      const res = await request(`/${WEBSITE}`, OWNER, { method: "POST", body: "not json" });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: "validation_error",
      });
      expect(automations.created).toHaveLength(0);
    });
  });

  // ─── Update ───────────────────────────────────────────────────────────────

  describe("PUT /:website_id/:id", () => {
    it("threads the patch to the named automation", async () => {
      const res = await request(`/${WEBSITE}/${AUTOMATION}`, OWNER, {
        method: "PUT",
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(res.status).toBe(200);
      expect(automations.updated[0]).toMatchObject({ automationId: AUTOMATION });
      expect(automations.updated[0]!.patch).toMatchObject({ name: "Renamed" });
    });

    it("answers 404 when there was nothing to update", async () => {
      automations.missing = true;
      const res = await request(`/${WEBSITE}/${AUTOMATION}`, OWNER, {
        method: "PUT",
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(res.status).toBe(404);
    });

    it("applies the same webhook validation as create", async () => {
      const res = await request(`/${WEBSITE}/${AUTOMATION}`, OWNER, {
        method: "PUT",
        body: JSON.stringify({
          definition: definition({ graph: graphOf({ type: "webhook", url: INTERNAL_WEBHOOK }) }),
        }),
      });
      expect(res.status).toBe(400);
      expect(automations.updated).toHaveLength(0);
    });

    it("accepts a patch that changes only the active flag", async () => {
      const res = await request(`/${WEBSITE}/${AUTOMATION}`, OWNER, {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── Delete and toggle ────────────────────────────────────────────────────

  describe("DELETE /:website_id/:id", () => {
    it("answers 204 with no body", async () => {
      const res = await request(`/${WEBSITE}/${AUTOMATION}`, OWNER, { method: "DELETE" });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(automations.removed).toEqual([AUTOMATION]);
    });

    it("is idempotent — deleting a missing automation is still 204", async () => {
      automations.missing = true;
      const res = await request(`/${WEBSITE}/${AUTOMATION}`, OWNER, { method: "DELETE" });
      expect(res.status).toBe(204);
    });
  });

  describe("DELETE /:website_id/bulk-delete", () => {
    it("is matched as its own route, not as an automation id", async () => {
      // Registration order is load-bearing: `/:website_id/:id` would otherwise
      // capture "bulk-delete" and delete an automation with that id.
      const res = await request(`/${WEBSITE}/bulk-delete`, OWNER, {
        method: "DELETE",
        body: JSON.stringify({ ids: ["a", "b"] }),
      });
      expect(res.status).toBe(204);
      expect(automations.bulkRemoved).toEqual([["a", "b"]]);
      expect(automations.removed).toHaveLength(0);
    });

    it("defaults to an empty id list when the body omits one", async () => {
      const res = await request(`/${WEBSITE}/bulk-delete`, OWNER, {
        method: "DELETE",
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(204);
      expect(automations.bulkRemoved).toEqual([[]]);
    });

    it("rejects more than five hundred ids", async () => {
      const res = await request(`/${WEBSITE}/bulk-delete`, OWNER, {
        method: "DELETE",
        body: JSON.stringify({ ids: Array.from({ length: 501 }, (_, i) => `a${i}`) }),
      });
      expect(res.status).toBe(400);
      expect(automations.bulkRemoved).toHaveLength(0);
    });

    it("rejects a blank or over-long id", async () => {
      for (const ids of [[""], ["a".repeat(129)]]) {
        const res = await request(`/${WEBSITE}/bulk-delete`, OWNER, {
          method: "DELETE",
          body: JSON.stringify({ ids }),
        });
        expect(res.status).toBe(400);
      }
    });

    it("answers a malformed body with a validation error rather than deleting", async () => {
      const res = await request(`/${WEBSITE}/bulk-delete`, OWNER, {
        method: "DELETE",
        body: "not json",
      });
      expect(res.status).toBe(400);
      expect(automations.bulkRemoved).toHaveLength(0);
    });
  });

  describe("POST /:website_id/:id/toggle", () => {
    it("flips the flag and returns the updated row", async () => {
      const res = await request(`/${WEBSITE}/${AUTOMATION}/toggle`, OWNER, { method: "POST" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: { isActive: boolean } };
      expect(body.data.isActive).toBe(false);
      expect(automations.toggled).toEqual([AUTOMATION]);
    });

    it("answers 404 for an automation that does not exist", async () => {
      automations.missing = true;
      const res = await request(`/${WEBSITE}/${AUTOMATION}/toggle`, OWNER, { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("requires POST — a GET must not silently toggle", async () => {
      const res = await request(`/${WEBSITE}/${AUTOMATION}/toggle`, OWNER);
      expect(res.status).toBe(404);
      expect(automations.toggled).toHaveLength(0);
    });
  });

  // ─── Coverage ─────────────────────────────────────────────────────────────

  describe("route coverage", () => {
    it("exercises every route the factory registers", async () => {
      const registered = new Set(
        createAutomationRoutes({ automationCrud: automations, automationInsights: automations, websites })
          .routes.filter((r) => r.method !== "ALL")
          .map((r) => `${r.method} ${r.path}`),
      );
      const tested = new Set(
        ROUTES.map(
          (r) =>
            `${r.method} ${r.path.replace(WEBSITE, ":website_id").replace(AUTOMATION, ":id")}`,
        ),
      );
      expect([...registered].filter((r) => !tested.has(r))).toEqual([]);
    });

    it("does not claim coverage of routes that no longer exist", async () => {
      const registered = new Set(
        createAutomationRoutes({ automationCrud: automations, automationInsights: automations, websites })
          .routes.filter((r) => r.method !== "ALL")
          .map((r) => `${r.method} ${r.path}`),
      );
      const tested = ROUTES.map(
        (r) => `${r.method} ${r.path.replace(WEBSITE, ":website_id").replace(AUTOMATION, ":id")}`,
      );
      expect(tested.filter((r) => !registered.has(r))).toEqual([]);
    });
  });
});
