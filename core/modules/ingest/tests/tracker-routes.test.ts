import { describe, it, expect, mock, beforeAll, beforeEach  } from "bun:test";
import type { WebsiteTrackerRow } from "../../websites/interfaces";
import type {
  AutomationEvaluation,
  AutomationRow,
  AutomationTrackerSettings,
  EvaluateRequest,
  EvaluateResult,
} from "../../automations/interfaces";
import type { Funnel, FunnelTrackerConfig } from "../../funnels/interfaces";
import type {
  BatchCaptureScreenshotResult,
  CaptureScreenshotRequest,
  CaptureScreenshotResult,
  HeatmapScreenshotCapture,
} from "../../heatmaps/interfaces";
import { testConfig } from "../../../app/tests/helpers/test-config";

// ─── Mocks — must be declared before dynamic import ─────────────────────────
//
// Only what the routes still import directly is mocked: the website lookup they
// share with every other tracker endpoint, the `/collect` sorters (ingest's own
// internals, exercised by their own tests), the logger, the config and the geo/UA
// enrichment. The four peer-module capabilities arrive through the factory as fakes
// further down — that is the whole point of the injection.

const mockResolveWebsite = mock(async (_id: string): Promise<WebsiteTrackerRow | null> => null);
const mockListGoals      = mock(async () => []);
const mockBuildConfig    = mock(async () => ({ website_id: "w1", goals: [], replay_enabled: false }));
// A complete `Logger`: `child` must exist and must itself return a logger, because
// modules call `log.child(...)` at import time. Bun's module mocks are global, so an
// incomplete stub here breaks every other test file that imports the real logger.
mock.module("../../../platform/lib/logger", () => {
  const logger: Record<string, unknown> = {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
  logger.child = () => logger;
  return { log: logger };
});

// dev environment → empty origin always passes, localhost always passes.
// Global to the whole run — see `testConfig` for why it must be complete.
mock.module("../../../config", () => ({ env: () => testConfig() }));

mock.module("../services/ingest-meta.service", () => ({
  buildAnalyticsIngestMeta: mock(() => ({
    country: "US", region: "CA", city: "SF",
    browser: "Chrome", device: "desktop", os: "macOS",
    languageHint: "en",
  })),
}));

// ─── Test helpers ────────────────────────────────────────────────────────────

const ACTIVE_WEBSITE: WebsiteTrackerRow = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  user_id: "user1",
  url: "https://example.com",
  is_active: true,
  funnel_enabled: true,
  heatmap_enabled: true,
  heatmap_include_patterns: null,
  heatmap_exclude_patterns: null,
  heatmap_layout_enabled: false,
  replay_enabled: true,
  replay_sampling_rate: 1.0,
  replay_include_patterns: null,
  replay_exclude_patterns: null,
  automation_enabled: true,
  respect_dnt: false,
  consent_mode: "cookieless",
};

/**
 * Active funnel definitions for `/init`.
 *
 * `activeForWebsiteRef` throws: reaching for it here would mean the route is making
 * the funnels module re-resolve a website it has already loaded.
 */
class FakeFunnelConfig implements FunnelTrackerConfig {
  /** Returned verbatim; the route only passes these through. */
  rows: unknown[] = [];
  fail = false;
  calls: string[] = [];

  async activeForTracker(websiteId: string): Promise<Funnel[]> {
    this.calls.push(websiteId);
    if (this.fail) throw new Error("DB down");
    return this.rows as Funnel[];
  }

}

/** Active automations for `/init`. */
class FakeAutomationSettings implements AutomationTrackerSettings {
  rows: AutomationRow[] = [];
  fail = false;
  calls: string[] = [];

  async activeFor(websiteRef: string): Promise<AutomationRow[]> {
    this.calls.push(websiteRef);
    if (this.fail) throw new Error("DB down");
    return this.rows;
  }
}

/** Server-side trigger evaluation. Records requests so identifier threading is assertable. */
class FakeAutomationEvaluation implements AutomationEvaluation {
  result: EvaluateResult = { matched: 0, actions: [] };
  fail = false;
  requests: EvaluateRequest[] = [];

  async evaluate(request: EvaluateRequest): Promise<EvaluateResult> {
    this.requests.push(request);
    if (this.fail) throw new Error("DB timeout");
    return this.result;
  }
}

/** On-demand Playwright capture. `captureBatch` throws — the tracker never batches. */
class FakeScreenshotCapture implements HeatmapScreenshotCapture {
  captures: { websiteRef: string; request: CaptureScreenshotRequest }[] = [];

  async capture(
    websiteRef: string,
    request: CaptureScreenshotRequest,
  ): Promise<CaptureScreenshotResult> {
    this.captures.push({ websiteRef, request });
    return { success: true, stored: true };
  }

  async captureBatch(): Promise<BatchCaptureScreenshotResult[]> {
    throw new Error("the tracker captures one page at a time");
  }
}

function makeAutomationRow(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: "a1",
    websiteId: ACTIVE_WEBSITE.id,
    userId: "user1",
    name: "Exit popup",
    definition: { trigger: "exit" },
    isActive: true,
    priority: 0,
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

// ─── Load the factory after the mocks ────────────────────────────────────────

let createTrackerRoutes: typeof import("../routes").createTrackerRoutes;
let createTrackerCollectService: typeof import("../services/tracker-collect.service").createTrackerCollectService;
/** Records enqueues so a test can assert what `/collect` buffered. */
function makeFakeQueue() {
  return {
    events: [] as unknown[],
    profiles: [] as unknown[],
    enqueue(lane: string, _websiteId: string, rows: readonly unknown[]) {
      if (lane === "analytics") this.events.push(...rows);
      if (lane === "profiles") this.profiles.push(...rows);
    },
  };
}

let app: ReturnType<typeof createTrackerRoutes>;
let queue: ReturnType<typeof makeFakeQueue>;
let funnels: FakeFunnelConfig;
let automations: FakeAutomationSettings;
let automationEvaluation: FakeAutomationEvaluation;
let screenshots: FakeScreenshotCapture;

beforeAll(async () => {
  ({ createTrackerRoutes } = await import("../routes"));
  ({ createTrackerCollectService } = await import("../services/tracker-collect.service"));
});

beforeEach(() => {
  mockResolveWebsite.mockClear();
  mockListGoals.mockClear();
  mockBuildConfig.mockClear();
  // Default: website not found
  mockResolveWebsite.mockResolvedValue(null);

  funnels = new FakeFunnelConfig();
  automations = new FakeAutomationSettings();
  automationEvaluation = new FakeAutomationEvaluation();
  screenshots = new FakeScreenshotCapture();

  // Requested at the paths `index.ts` mounts under `/api/v1/tracker`.
  queue = makeFakeQueue();
  app = createTrackerRoutes({
    collect: createTrackerCollectService(queue),
    automations,
    automationEvaluation,
    funnels,
    screenshots,
    trackerWebsites: {
      resolve: mockResolveWebsite,
      listGoals: mockListGoals,
      buildConfig: mockBuildConfig,
    },
  });
});

// ─── GET /init/:website_id ───────────────────────────────────────────────────

describe("GET /init/:website_id", () => {
  it("returns 404 when website is not found", async () => {
    const res = await app.request("/init/unknown_id");
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBeDefined();
  });

  it("returns 404 when website is inactive", async () => {
    mockResolveWebsite.mockResolvedValue({ ...ACTIVE_WEBSITE, is_active: false });
    const res = await app.request("/init/site_abc");
    expect(res.status).toBe(404);
  });

  it("returns 403 when origin does not match registered domain (production env would block)", async () => {
    // Switch to production just for this test via mockResolveWebsite returning a website
    // with a domain that won't match the sent origin
    mockResolveWebsite.mockResolvedValue({ ...ACTIVE_WEBSITE, url: "https://example.com" });
    // In development, origin mismatch with a non-loopback host → 403
    const res = await app.request("/init/site_abc", {
      headers: { Origin: "https://evil.com" },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toContain("domain");
  });

  it("returns 200 with config, funnels, automations for a valid request", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    mockBuildConfig.mockResolvedValue({ website_id: "w1", goals: [], replay_enabled: true });
    funnels.rows = [{ id: "f1", name: "Checkout" }];
    automations.rows = [makeAutomationRow()];

    const res = await app.request("/init/site_abc");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.config).toBeDefined();
    expect(Array.isArray(body.funnels)).toBe(true);
    expect(Array.isArray(body.automations)).toBe(true);
    // The definition is spread onto the automation, alongside id and name only.
    expect(body.automations).toEqual([{ id: "a1", name: "Exit popup", trigger: "exit" }]);
    // Both modules receive the resolved UUID, never the `site_abc` reference.
    expect(funnels.calls).toEqual([ACTIVE_WEBSITE.id]);
    expect(automations.calls).toEqual([ACTIVE_WEBSITE.id]);
  });

  it("sets Cache-Control header on success", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    const res = await app.request("/init/site_abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("max-age=60");
  });

  it("returns empty funnels and automations when services fail (silent fallback)", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    funnels.fail = true;
    automations.fail = true;

    const res = await app.request("/init/site_abc");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.funnels).toEqual([]);
    expect(body.automations).toEqual([]);
  });
});

// ─── GET /config/:website_id ─────────────────────────────────────────────────

describe("GET /config/:website_id", () => {
  it("returns 404 when website is not found", async () => {
    const res = await app.request("/config/unknown");
    expect(res.status).toBe(404);
  });

  it("returns 404 when website is inactive", async () => {
    mockResolveWebsite.mockResolvedValue({ ...ACTIVE_WEBSITE, is_active: false });
    const res = await app.request("/config/site_abc");
    expect(res.status).toBe(404);
  });

  it("returns 200 with config on success", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    mockBuildConfig.mockResolvedValue({ website_id: "w1", goals: [], replay_enabled: false });

    const res = await app.request("/config/site_abc");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.website_id).toBe("w1");
  });

  it("sets Cache-Control header on success", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    const res = await app.request("/config/site_abc");
    expect(res.headers.get("Cache-Control")).toContain("max-age=60");
  });
});

// ─── POST /collect ───────────────────────────────────────────────────────────

describe("POST /collect", () => {
  it("returns 400 for invalid JSON body", async () => {
    const res = await app.request("/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json }",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when website_id is missing", async () => {
    const res = await app.request("/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ type: "pageview" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when website_id is empty string", async () => {
    const res = await app.request("/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website_id: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 'nothing to process' when all arrays are empty", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    const res = await app.request("/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website_id: "site_abc", events: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.message).toBe("nothing to process");
    expect(mockResolveWebsite).not.toHaveBeenCalled();
  });

  it("returns 404 when website is not found", async () => {
    const res = await app.request("/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website_id: "unknown", events: [{ type: "pageview" }] }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when origin does not match", async () => {
    mockResolveWebsite.mockResolvedValue({ ...ACTIVE_WEBSITE, url: "https://example.com" });
    const res = await app.request("/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.com" },
      body: JSON.stringify({ website_id: "site_abc", events: [{ type: "pageview" }] }),
    });
    expect(res.status).toBe(403);
  });

  it("does not enqueue when the site honors a browser DNT signal", async () => {
    mockResolveWebsite.mockResolvedValue({ ...ACTIVE_WEBSITE, respect_dnt: true });
    const res = await app.request("/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json", DNT: "1" },
      body: JSON.stringify({ website_id: "site_abc", events: [{ type: "pageview" }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { message: string }).message).toBe("tracking disabled by privacy policy");
    expect(queue.events).toHaveLength(0);
  });

  it("requires an explicit consent flag for strict sites", async () => {
    mockResolveWebsite.mockResolvedValue({ ...ACTIVE_WEBSITE, consent_mode: "strict" });
    const denied = await app.request("/collect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website_id: "site_abc", events: [{ type: "pageview" }] }),
    });
    expect((await denied.json() as { message: string }).message).toBe("tracking disabled by privacy policy");

    const allowed = await app.request("/collect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website_id: "site_abc", consent: true, events: [{ type: "pageview" }] }),
    });
    expect(allowed.status).toBe(200);
    expect(queue.events).toHaveLength(1);
  });

  it("returns 200 and enqueues events for a valid collect payload", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    const res = await app.request("/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        website_id: "site_abc",
        events: [{ type: "pageview", url: "/home", ts: Date.now() }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.queued).toBe(1);
    expect(queue.events).toHaveLength(1);
  });

  it("queued count reflects total items across all arrays", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    const res = await app.request("/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        website_id: "site_abc",
        events: [{ type: "pageview" }, { type: "custom" }],
        funnels: [{}],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.queued).toBe(3);
  });

  it("rejects body over 8MB via Content-Length header", async () => {
    const res = await app.request("/collect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(9 * 1024 * 1024),
      },
      body: JSON.stringify({ website_id: "site_abc" }),
    });
    expect(res.status).toBe(400);
  });

  it("uses body.ua as UA when User-Agent is a server runtime (Bun)", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    await app.request("/collect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Bun/1.0.0",
      },
      body: JSON.stringify({
        website_id: "site_abc",
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
        events: [{ type: "pageview" }],
      }),
    });
    // Just assert it didn't crash — the UA override path was exercised
    expect(queue.events).toHaveLength(1);
  });
});

// ─── POST /request-screenshot ────────────────────────────────────────────────

describe("POST /request-screenshot", () => {
  it("returns 400 for invalid JSON", async () => {
    const res = await app.request("/request-screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "bad json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when website_id is missing", async () => {
    const res = await app.request("/request-screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_url: "https://example.com/p", page_path: "/p" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when page_url is missing", async () => {
    const res = await app.request("/request-screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website_id: "site_abc", page_path: "/p" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid page_url", async () => {
    const res = await app.request("/request-screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website_id: "site_abc", page_url: "not-a-url", page_path: "/p" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when page_url is an internal host (SSRF guard)", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    const res = await app.request("/request-screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        website_id: "site_abc",
        page_url: "http://localhost/admin",
        page_path: "/admin",
      }),
    });
    expect(res.status).toBe(400);
    expect(screenshots.captures).toEqual([]);
  });

  it("returns 400 when page_url is on a different domain than the website (SSRF guard)", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    const res = await app.request("/request-screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        website_id: "site_abc",
        page_url: "https://evil.com/page",
        page_path: "/page",
      }),
    });
    expect(res.status).toBe(400);
    expect(screenshots.captures).toEqual([]);
  });

  it("returns 404 when website is not found", async () => {
    const res = await app.request("/request-screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        website_id: "missing",
        page_url: "https://example.com/page",
        page_path: "/page",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 202 and fires Playwright capture for a valid request", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    const res = await app.request("/request-screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        website_id: "site_abc",
        page_url: "https://example.com/home",
        page_path: "/home",
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.status).toBe("queued");
    expect(screenshots.captures).toEqual([
      {
        websiteRef: "site_abc",
        request: { pageUrl: "https://example.com/home", pagePath: "/home", force: false },
      },
    ]);
  });

  it("still answers 202 when the capture rejects (fire-and-forget)", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    screenshots.capture = async () => {
      throw new Error("Website not found");
    };
    const res = await app.request("/request-screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        website_id: "site_abc",
        page_url: "https://example.com/home",
        page_path: "/home",
      }),
    });
    expect(res.status).toBe(202);
  });
});

// ─── POST /automations/evaluate ──────────────────────────────────────────────

describe("POST /automations/evaluate", () => {
  const validBody = {
    website_id: "site_abc",
    anonymous_id: "anon_1",
    session_id: "sess_1",
    trigger: { type: "exit_intent" },
  };

  it("returns 400 for invalid JSON", async () => {
    const res = await app.request("/automations/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "bad json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when website_id is missing", async () => {
    const res = await app.request("/automations/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anonymous_id: "a", session_id: "s", trigger: { type: "exit" } }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when anonymous_id or session_id is missing", async () => {
    const res = await app.request("/automations/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website_id: "site_abc", trigger: { type: "exit" } }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when trigger is missing", async () => {
    const res = await app.request("/automations/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website_id: "site_abc", anonymous_id: "a", session_id: "s" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when trigger has no type", async () => {
    const res = await app.request("/automations/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, trigger: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when website is not found", async () => {
    const res = await app.request("/automations/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when origin does not match", async () => {
    mockResolveWebsite.mockResolvedValue({ ...ACTIVE_WEBSITE, url: "https://example.com" });
    const res = await app.request("/automations/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.com" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(403);
  });

  it("returns 200 with matched and actions on success", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    automationEvaluation.result = {
      matched: 1,
      actions: [{ type: "show_modal", automation_id: "a1", run_id: "run_1" }],
    };

    const res = await app.request("/automations/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.matched).toBe(1);
    expect(body.actions).toHaveLength(1);
    // Both identifiers are passed through already resolved — the UUID keys the
    // tables the evaluation reads, the websiteId only labels the events it publishes.
    expect(automationEvaluation.requests).toEqual([
      {
        websiteId: ACTIVE_WEBSITE.id,
        anonymousId: "anon_1",
        userId: null,
        sessionId: "sess_1",
        trigger: { type: "exit_intent" },
        context: {},
      },
    ]);
  });

  it("returns 500 when evaluation throws", async () => {
    mockResolveWebsite.mockResolvedValue(ACTIVE_WEBSITE);
    automationEvaluation.fail = true;

    const res = await app.request("/automations/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(500);
  });
});
