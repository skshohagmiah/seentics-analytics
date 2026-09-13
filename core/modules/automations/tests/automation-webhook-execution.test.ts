import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { failInserts, fakeDbModule, fakeLogger, insertsInto, resetDb } from "./helpers/fake-db";

/**
 * Outbound webhook delivery.
 *
 * This is the one place an automation definition becomes a network call the server
 * makes on its own behalf, which makes it the module's SSRF boundary — the schema
 * validates a URL at write time, but a definition can also reach storage by other
 * routes, so the executor re-checks rather than trusting what it was handed.
 *
 * Retry timing is driven through the injected policy so the back-off is exercised
 * without spending seven real seconds per test.
 */

mock.module("../../../db", fakeDbModule);
mock.module("../../../platform/lib/logger", fakeLogger);

let executeWebhook: typeof import("../services/automation-webhook-execution.service").executeWebhook;
let DEFAULT_WEBHOOK_RETRY: typeof import("../services/automation-webhook-execution.service").DEFAULT_WEBHOOK_RETRY;

beforeAll(async () => {
  ({ executeWebhook, DEFAULT_WEBHOOK_RETRY } = await import("../services/automation-webhook-execution.service"));
});

const AUTOMATION = "auto_1";
const SAFE_URL = "https://hooks.example.com/inbound";
/** No back-off, but the same attempt count, so retry logic runs at full speed. */
const FAST = { maxAttempts: 4, baseDelayMs: 0 };

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];

/** Install a fetch that answers from a scripted queue, cycling on the last entry. */
function scriptFetch(...responses: Array<Response | Error>) {
  let i = 0;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next ?? new Response("", { status: 200 });
  }) as typeof fetch;
}

function ok(status = 200) {
  return new Response(JSON.stringify({ ok: true }), { status });
}

/** The single delivery row written for the last call. */
function deliveryRow(): Record<string, unknown> {
  const rows = insertsInto("webhook_deliveries").flatMap((i) => i.rows) as Array<
    Record<string, unknown>
  >;
  if (rows.length !== 1) throw new Error(`expected one delivery row, got ${rows.length}`);
  return rows[0]!;
}

beforeEach(() => {
  resetDb();
  fetchCalls = [];
  scriptFetch(ok());
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── SSRF ────────────────────────────────────────────────────────────────────

describe("SSRF guard", () => {
  const blocked = [
    ["cloud metadata by IP", "https://169.254.169.254/latest/meta-data/"],
    ["loopback by name", "https://localhost/hook"],
    ["loopback by IP", "https://127.0.0.1/hook"],
    ["private range", "https://10.0.0.5/hook"],
    ["private range (172)", "https://172.16.0.1/hook"],
    ["private range (192.168)", "https://192.168.1.1/hook"],
    ["docker host alias", "https://host.docker.internal/hook"],
    ["internal TLD", "https://payments.internal/hook"],
    ["IPv6 loopback", "https://[::1]/hook"],
    ["plain http", "http://hooks.example.com/inbound"],
    ["not a URL", "not-a-url"],
    ["empty", ""],
  ] as const;

  for (const [name, url] of blocked) {
    it(`blocks ${name} without making a request`, async () => {
      await executeWebhook(AUTOMATION, { url }, {}, "run_1", FAST);
      expect(fetchCalls).toHaveLength(0);
    });
  }

  it("records a blocked delivery so the failure is visible in the dashboard", async () => {
    // Silently dropping it would leave the user with an automation that appears to
    // fire and a webhook that never arrives, and no way to tell which.
    await executeWebhook(AUTOMATION, { url: "https://127.0.0.1/hook" }, {}, "run_1", FAST);

    expect(deliveryRow()).toMatchObject({
      automationId: AUTOMATION,
      runId: "run_1",
      success: false,
      attemptCount: 0,
      statusCode: null,
      error: "URL blocked: failed SSRF validation",
    });
  });

  it("allows an ordinary public https endpoint", async () => {
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);
    expect(fetchCalls).toHaveLength(1);
  });

  it("does not throw when the blocked-delivery log itself fails", async () => {
    failInserts();
    await expect(
      executeWebhook(AUTOMATION, { url: "https://127.0.0.1/hook" }, {}, "run_1", FAST),
    ).resolves.toBeUndefined();
  });
});

// ─── Request shape ───────────────────────────────────────────────────────────

describe("request", () => {
  it("defaults to POST with a JSON content type", async () => {
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);

    const [call] = fetchCalls;
    expect(call!.url).toBe(SAFE_URL);
    expect(call!.init.method).toBe("POST");
    expect((call!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("uppercases a lower-case method", async () => {
    await executeWebhook(AUTOMATION, { url: SAFE_URL, method: "put" }, {}, "run_1", FAST);
    expect(fetchCalls[0]!.init.method).toBe("PUT");
  });

  it("merges caller headers over the defaults", async () => {
    await executeWebhook(
      AUTOMATION,
      { url: SAFE_URL, headers: { "X-Api-Key": "secret" } },
      {},
      "run_1",
      FAST,
    );
    expect((fetchCalls[0]!.init.headers as Record<string, string>)["X-Api-Key"]).toBe("secret");
  });

  it("stamps the automation id and a timestamp onto the payload", async () => {
    await executeWebhook(AUTOMATION, { url: SAFE_URL, body: { hello: "world" } }, {}, "run_1", FAST);

    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ hello: "world", _automation_id: AUTOMATION });
    expect(typeof body._ts).toBe("number");
  });

  it("renders templates in the body against the evaluation context", async () => {
    await executeWebhook(
      AUTOMATION,
      { url: SAFE_URL, body: { greeting: "Hi {{ user.name }}", page: "{{ page }}" } },
      { user: { name: "Ada" }, page: "/pricing" },
      "run_1",
      FAST,
    );

    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as Record<string, unknown>;
    expect(body.greeting).toBe("Hi Ada");
    expect(body.page).toBe("/pricing");
  });

  it("sends an empty object when the action carries no body", async () => {
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);
    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["_automation_id", "_ts"]);
  });

  it("applies a timeout so a hanging endpoint cannot pin the request", async () => {
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);
    expect(fetchCalls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ─── Retry ───────────────────────────────────────────────────────────────────

describe("retry", () => {
  it("makes a single attempt when the first succeeds", async () => {
    scriptFetch(ok());
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);

    expect(fetchCalls).toHaveLength(1);
    expect(deliveryRow()).toMatchObject({ success: true, statusCode: 200, attemptCount: 1 });
  });

  it("records the attempts actually made, not the ceiling", async () => {
    // This was hard-coded to the maximum, so a first-try success was logged as four
    // attempts and the retry column could not distinguish a flaky endpoint.
    scriptFetch(ok(500), ok(200));
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);

    expect(fetchCalls).toHaveLength(2);
    expect(deliveryRow().attemptCount).toBe(2);
  });

  it("retries a 5xx and stops on the first success", async () => {
    scriptFetch(ok(503), ok(503), ok(200), ok(200));
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);

    expect(fetchCalls).toHaveLength(3);
    expect(deliveryRow()).toMatchObject({ success: true, statusCode: 200, attemptCount: 3 });
  });

  it("retries a 4xx too — the endpoint may be misconfigured transiently", async () => {
    scriptFetch(ok(404));
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);
    expect(fetchCalls).toHaveLength(4);
  });

  it("gives up after the configured number of attempts", async () => {
    scriptFetch(ok(500));
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);

    expect(fetchCalls).toHaveLength(4);
    expect(deliveryRow()).toMatchObject({
      success: false,
      statusCode: 500,
      attemptCount: 4,
      error: "HTTP 500",
    });
  });

  it("retries a network error and records the message", async () => {
    scriptFetch(new Error("ECONNREFUSED"));
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);

    expect(fetchCalls).toHaveLength(4);
    expect(deliveryRow()).toMatchObject({
      success: false,
      statusCode: null,
      error: "ECONNREFUSED",
    });
  });

  it("recovers from a network error on a later attempt", async () => {
    scriptFetch(new Error("ECONNREFUSED"), ok(200));
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);

    expect(deliveryRow()).toMatchObject({ success: true, statusCode: 200, attemptCount: 2 });
  });

  it("honours a single-attempt policy", async () => {
    scriptFetch(ok(500));
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", {
      maxAttempts: 1,
      baseDelayMs: 0,
    });
    expect(fetchCalls).toHaveLength(1);
  });

  it("backs off exponentially between attempts", async () => {
    // 10 + 20 + 30ms of scheduled sleep across three gaps; the assertion is only that
    // the delays grow, not their exact wall-clock values.
    scriptFetch(ok(500));
    const started = Date.now();
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", {
      maxAttempts: 3,
      baseDelayMs: 10,
    });
    // Two gaps: 10ms then 20ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it("defaults to four attempts with a one-second base delay", async () => {
    expect(DEFAULT_WEBHOOK_RETRY).toEqual({ maxAttempts: 4, baseDelayMs: 1_000 });
  });
});

// ─── Delivery log ────────────────────────────────────────────────────────────

describe("delivery log", () => {
  it("writes exactly one row per delivery, whatever the attempt count", async () => {
    scriptFetch(ok(500));
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);
    expect(insertsInto("webhook_deliveries")).toHaveLength(1);
  });

  it("carries the run id so a delivery ties back to the automation run", async () => {
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_42", FAST);
    expect(deliveryRow().runId).toBe("run_42");
  });

  it("stores null for an absent run id rather than the string undefined", async () => {
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, undefined, FAST);
    expect(deliveryRow().runId).toBeNull();
  });

  it("records the target URL", async () => {
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);
    expect(deliveryRow().url).toBe(SAFE_URL);
  });

  it("clears the error on a successful delivery", async () => {
    await executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST);
    expect(deliveryRow().error).toBeNull();
  });

  it("does not throw when the delivery log write fails", async () => {
    // Best-effort by design: losing the audit row must not turn a delivered webhook
    // into a rejected promise the caller then logs as a failed action.
    failInserts();
    await expect(
      executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST),
    ).resolves.toBeUndefined();
  });

  it("resolves rather than rejecting when every attempt fails", async () => {
    scriptFetch(new Error("down"));
    await expect(
      executeWebhook(AUTOMATION, { url: SAFE_URL }, {}, "run_1", FAST),
    ).resolves.toBeUndefined();
  });
});
