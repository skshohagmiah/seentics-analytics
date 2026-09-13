import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { fakeDbModule, fakeLogger, insertsInto, resetDb, transactions } from "./helpers/fake-db";
import type { EvaluateRequest } from "../interfaces";
import type { AutomationGraph, GraphNode } from "../lib/automation-graph";

/**
 * The evaluation pipeline.
 *
 * Which *route* a graph takes is settled exhaustively in `automation-graph-walk.test.ts`
 * — that logic is pure, so it is tested without a request. What this file covers is
 * everything around the walk: matching a trigger, discarding an automation whose route
 * reaches nothing before paying for its cap lookup, dispatching what the walk produced,
 * and the two delivery guarantees the service documents.
 */

const listActive = mock(async (_websiteId: string) => automationRows);
const executeWebhook = mock(async () => {});

mock.module("../../../db", fakeDbModule);
mock.module("../../../platform/lib/logger", fakeLogger);

let AutomationEvaluationService: typeof import("../services/automation-evaluation.service").AutomationEvaluationService;

let automationRows: Array<{ id: string; definition: Record<string, unknown> }> = [];
beforeAll(async () => {
  ({ AutomationEvaluationService } = await import("../services/automation-evaluation.service"));
});

const WEBSITE = "11111111-1111-4111-8111-111111111111";
const VISITOR = "anon_1";
const SESSION = "sess_1";

// -- Builders ----------------------------------------------------------------

const act = (id: string, type: string, config: Record<string, unknown> = {}): GraphNode => ({
  id,
  kind: "action",
  action: { type, ...config },
});
const hookNode = (id: string, url = "https://hooks.example.com/x"): GraphNode => ({
  id,
  kind: "action",
  action: { type: "webhook", url },
});
const ifNode = (id: string, fact: string, value: unknown): GraphNode => ({
  id,
  kind: "if",
  group: { operator: "AND", rules: [{ fact, operator: "equals", value }] },
});
const delayNode = (id: string, seconds: number): GraphNode => ({ id, kind: "delay", seconds });
const waitNode = (id: string, fact: string, value: unknown, timeoutSeconds = 30): GraphNode => ({
  id,
  kind: "wait_until",
  group: { operator: "AND", rules: [{ fact, operator: "equals", value }] },
  timeoutSeconds,
});
const edge = (from: string, to: string, branch?: string) => ({ from, to, branch });

/** A graph of one action — the smallest thing that fires. */
function oneAction(type = "show_banner"): AutomationGraph {
  return { entry: "a", nodes: [act("a", type)], edges: [] };
}

function automation(id: string, definition: Record<string, unknown>) {
  return { id, definition };
}

/** One trigger and a graph. */
function auto(id: string, graph: AutomationGraph, over: Record<string, unknown> = {}) {
  return automation(id, { triggers: [{ type: "exit_intent" }], graph, ...over });
}

function request(over: Partial<EvaluateRequest> = {}): EvaluateRequest {
  return {
    websiteId: WEBSITE,
    anonymousId: VISITOR,
    sessionId: SESSION,
    trigger: { type: "exit_intent" },
    context: { page: "/pricing" },
    ...over,
  };
}

/**
 * The service with its collaborators injected.
 *
 * Injection rather than `mock.module`: Bun's mock registry is process-global, so
 * stubbing the webhook executor here would replace it for its own test file too.
 */
function service() {
  return new AutomationEvaluationService({
    listActiveAutomationsByPriority: listActive as never,
    executeWebhook: executeWebhook as never,
  });
}

/** Let the fire-and-forget `.then`/`.catch` chains settle before asserting. */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function eventRows(recordType: string): Array<Record<string, unknown>> {
  return (insertsInto("automation_events").flatMap((i) => i.rows) as Array<Record<string, unknown>>)
    .filter((r) => r.recordType === recordType);
}

beforeEach(() => {
  resetDb();
  automationRows = [];
  listActive.mockClear();
  executeWebhook.mockClear();
});

// -- Trigger matching --------------------------------------------------------

describe("trigger matching", () => {
  it("fires an automation whose trigger type matches", async () => {
    automationRows = [auto("a1", oneAction())];
    expect((await service().evaluate(request())).matched).toBe(1);
  });

  it("skips an automation listening for a different trigger", async () => {
    automationRows = [automation("a1", { triggers: [{ type: "page_view" }], graph: oneAction() })];
    expect((await service().evaluate(request())).matched).toBe(0);
  });

  it("fires when any entry in the triggers array matches", async () => {
    automationRows = [
      automation("a1", {
        triggers: [{ type: "page_view" }, { type: "exit_intent" }],
        graph: oneAction(),
      }),
    ];
    expect((await service().evaluate(request())).matched).toBe(1);
  });

  it("never fires an automation with no triggers", async () => {
    automationRows = [automation("a1", { graph: oneAction() })];
    expect((await service().evaluate(request())).matched).toBe(0);
  });

  it("matches trigger types exactly, not by prefix", async () => {
    automationRows = [automation("a1", { triggers: [{ type: "click" }], graph: oneAction() })];
    expect((await service().evaluate(request({ trigger: { type: "rage_click" } }))).matched).toBe(0);
  });

  it("scopes the automation lookup to the requesting website", async () => {
    await service().evaluate(request());
    expect(listActive).toHaveBeenCalledWith(WEBSITE);
  });

  it("fires once for a definition listing the same trigger twice", async () => {
    automationRows = [
      automation("a1", {
        triggers: [{ type: "exit_intent" }, { type: "exit_intent" }],
        graph: oneAction(),
      }),
    ];
    const out = await service().evaluate(request());
    expect(out.matched).toBe(1);
    expect(insertsInto("automation_impressions").flatMap((i) => i.rows)).toHaveLength(1);
  });
});

// -- Candidate gating --------------------------------------------------------

describe("candidate gating", () => {
  it("does not fire when the route reaches nothing", async () => {
    // The branch taken leads to an unconnected outlet, so there is nothing to do — and
    // charging an impression for a run that produced nothing would cap the visitor for
    // an automation they never saw.
    automationRows = [
      auto("a1", {
        entry: "if1",
        nodes: [ifNode("if1", "plan", "pro"), act("yes", "show_toast")],
        edges: [edge("if1", "yes", "true")],
      }),
    ];
    const out = await service().evaluate(request({ context: { plan: "free" } }));

    expect(out.matched).toBe(0);
    expect(insertsInto("automation_impressions")).toHaveLength(0);
  });

  it("fires when the route reaches an action", async () => {
    automationRows = [
      auto("a1", {
        entry: "if1",
        nodes: [ifNode("if1", "plan", "pro"), act("yes", "show_toast")],
        edges: [edge("if1", "yes", "true")],
      }),
    ];
    expect((await service().evaluate(request({ context: { plan: "pro" } }))).matched).toBe(1);
  });

  it("fires when the route reaches only a webhook", async () => {
    // Nothing is returned to the tracker, but the automation did run.
    automationRows = [auto("a1", { entry: "h", nodes: [hookNode("h")], edges: [] })];
    const out = await service().evaluate(request());
    await flush();

    expect(out.matched).toBe(1);
    expect(out.actions).toEqual([]);
    expect(executeWebhook).toHaveBeenCalledTimes(1);
  });

  it("does not fire an automation with no graph", async () => {
    automationRows = [automation("a1", { triggers: [{ type: "exit_intent" }] })];
    expect((await service().evaluate(request())).matched).toBe(0);
  });

  it("tolerates a definition whose graph is the wrong shape", async () => {
    automationRows = [automation("a1", { triggers: [{ type: "exit_intent" }], graph: "nope" } as never)];
    await expect(service().evaluate(request())).resolves.toMatchObject({ matched: 0 });
  });
});

// -- Dispatch ----------------------------------------------------------------

describe("client actions", () => {
  it("tags each action with its automation and run", async () => {
    automationRows = [auto("a1", { entry: "a", nodes: [act("a", "show_banner", { text: "Hi" })], edges: [] })];
    const out = await service().evaluate(request());

    expect(out.actions[0]).toMatchObject({ type: "show_banner", text: "Hi", automation_id: "a1" });
    expect(String(out.actions[0]!.run_id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carries the walk's delay offset as delay_ms", async () => {
    automationRows = [
      auto("a1", {
        entry: "d",
        nodes: [delayNode("d", 5), act("a", "show_banner")],
        edges: [edge("d", "a")],
      }),
    ];
    expect((await service().evaluate(request())).actions[0]!.delay_ms).toBe(5000);
  });

  it("omits delay_ms entirely when there is no delay", async () => {
    automationRows = [auto("a1", oneAction())];
    expect((await service().evaluate(request())).actions[0]).not.toHaveProperty("delay_ms");
  });

  it("gives every action of one run the same run id", async () => {
    automationRows = [
      auto("a1", {
        entry: "a",
        nodes: [act("a", "show_banner"), act("b", "show_toast")],
        edges: [edge("a", "b")],
      }),
    ];
    const out = await service().evaluate(request());
    expect(new Set(out.actions.map((a) => a.run_id)).size).toBe(1);
  });

  it("gives two automations in the same evaluate different run ids", async () => {
    automationRows = [auto("a1", oneAction()), auto("a2", oneAction("show_toast"))];
    const out = await service().evaluate(request());
    expect(new Set(out.actions.map((a) => a.run_id)).size).toBe(2);
  });

  it("does not let an action forge the fields the server stamps on it", async () => {
    automationRows = [
      auto("a1", {
        entry: "a",
        nodes: [act("a", "show_banner", { automation_id: "spoofed", run_id: "spoofed" })],
        edges: [],
      }),
    ];
    const out = await service().evaluate(request());
    expect(out.actions[0]!.automation_id).toBe("a1");
    expect(out.actions[0]!.run_id).not.toBe("spoofed");
  });

  it("renders templates against the evaluation context", async () => {
    automationRows = [
      auto("a1", {
        entry: "a",
        nodes: [act("a", "show_banner", { text: "Hi {{ user.name }}" })],
        edges: [],
      }),
    ];
    const out = await service().evaluate(request({ context: { user: { name: "Ada" } } }));
    expect(out.actions[0]!.text).toBe("Hi Ada");
  });

  it("keys actions by their position on the route taken", async () => {
    // The run log should read as the path the visitor walked, not as positions in the
    // stored graph — otherwise an edited automation's history stops lining up.
    automationRows = [
      auto("a1", {
        entry: "if1",
        nodes: [ifNode("if1", "plan", "pro"), act("skip", "redirect"), act("taken", "show_toast")],
        edges: [edge("if1", "skip", "true"), edge("if1", "taken", "false")],
      }),
    ];
    await service().evaluate(request({ context: { plan: "free" } }));
    await flush();
    expect(eventRows("action").map((r) => r.actionKey)).toEqual(["show_toast_0"]);
  });
});

describe("webhook actions", () => {
  it("dispatches server-side and keeps it out of the client response", async () => {
    automationRows = [auto("a1", { entry: "h", nodes: [hookNode("h")], edges: [] })];
    const out = await service().evaluate(request());
    await flush();

    expect(out.actions).toEqual([]);
    expect(executeWebhook).toHaveBeenCalledTimes(1);
  });

  it("passes the automation id, action, context and run id to the executor", async () => {
    automationRows = [auto("a1", { entry: "h", nodes: [hookNode("h")], edges: [] })];
    await service().evaluate(request());
    await flush();

    const [automationId, action, context, runId] = executeWebhook.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
      string,
    ];
    expect(automationId).toBe("a1");
    expect(action.url).toBe("https://hooks.example.com/x");
    expect(context.page).toBe("/pricing");
    expect(String(runId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not fail the evaluate when a webhook rejects", async () => {
    executeWebhook.mockImplementationOnce(async () => {
      throw new Error("endpoint down");
    });
    automationRows = [
      auto("a1", { entry: "h", nodes: [hookNode("h"), act("a", "show_banner")], edges: [edge("h", "a")] }),
    ];
    const out = await service().evaluate(request());
    await flush();

    expect(out.matched).toBe(1);
    expect(out.actions).toHaveLength(1);
  });

  it("records a failed webhook in the run log", async () => {
    executeWebhook.mockImplementationOnce(async () => {
      throw new Error("endpoint down");
    });
    automationRows = [auto("a1", { entry: "h", nodes: [hookNode("h")], edges: [] })];
    await service().evaluate(request());
    await flush();

    expect(eventRows("action").some((r) => r.status === "failed")).toBe(true);
  });

  it("is not dispatched when the route does not reach it", async () => {
    // The most important consequence of branching: a gate stops outbound requests, not
    // just visible actions.
    automationRows = [
      auto("a1", {
        entry: "if1",
        nodes: [ifNode("if1", "plan", "pro"), hookNode("h"), act("a", "show_banner")],
        edges: [edge("if1", "h", "true"), edge("if1", "a", "false")],
      }),
    ];
    await service().evaluate(request({ context: { plan: "free" } }));
    await flush();
    expect(executeWebhook).not.toHaveBeenCalled();
  });
});

// -- Waits -------------------------------------------------------------------

describe("wait_until", () => {
  function waiting(): AutomationGraph {
    return {
      entry: "w",
      nodes: [waitNode("w", "scrolled", "true"), act("m", "show_toast"), act("t", "show_banner")],
      edges: [edge("w", "m", "met"), edge("w", "t", "timeout")],
    };
  }

  it("emits the remainder as a continuation for the browser to finish", async () => {
    automationRows = [auto("a1", waiting())];
    const out = await service().evaluate(request());

    const cont = out.actions.find((a) => a.type === "continue_when");
    expect(cont).toBeDefined();
    expect(cont!.automation_id).toBe("a1");
  });

  it("precomputes both outcomes so the page needs no second round trip", async () => {
    automationRows = [auto("a1", waiting())];
    const out = await service().evaluate(request());
    const c = out.actions.find((a) => a.type === "continue_when")!.continuation as {
      met: Array<{ type: string }>;
      timeout: Array<{ type: string }>;
      timeoutMs: number;
    };

    expect(c.met.map((a) => a.type)).toEqual(["show_toast"]);
    expect(c.timeout.map((a) => a.type)).toEqual(["show_banner"]);
    expect(c.timeoutMs).toBe(30_000);
  });

  it("renders templates in both branches before handing them over", async () => {
    // The page cannot resolve `{{ user.name }}` — those facts live on the server.
    automationRows = [
      auto("a1", {
        entry: "w",
        nodes: [
          waitNode("w", "x", "1"),
          act("m", "show_toast", { message: "Hi {{ user.name }}" }),
          act("t", "show_banner", { text: "Bye {{ user.name }}" }),
        ],
        edges: [edge("w", "m", "met"), edge("w", "t", "timeout")],
      }),
    ];
    const out = await service().evaluate(request({ context: { user: { name: "Ada" } } }));
    const c = out.actions.find((a) => a.type === "continue_when")!.continuation as {
      met: Array<{ message: string }>;
      timeout: Array<{ text: string }>;
    };

    expect(c.met[0]!.message).toBe("Hi Ada");
    expect(c.timeout[0]!.text).toBe("Bye Ada");
  });

  it("still returns the actions resolved before the wait", async () => {
    automationRows = [
      auto("a1", {
        entry: "a",
        nodes: [act("a", "show_banner"), waitNode("w", "x", "1"), act("m", "show_toast")],
        edges: [edge("a", "w"), edge("w", "m", "met")],
      }),
    ];
    const out = await service().evaluate(request());
    expect(out.actions.map((a) => a.type)).toEqual(["show_banner", "continue_when"]);
  });
});

// -- Durability --------------------------------------------------------------

describe("impressions", () => {
  /**
   * One statement, and no transaction around it.
   *
   * This used to open a transaction so the impression rows and a set of
   * `automation.triggered` outbox rows would commit together. Nothing ever subscribed to
   * that event, so the outbox row, the once-a-second poll that drained it, and the
   * transaction holding a pooled connection open across both all existed to inform nobody.
   */
  it("records impressions without opening a transaction", async () => {
    automationRows = [auto("a1", oneAction())];
    await service().evaluate(request());

    expect(insertsInto("automation_impressions")).toHaveLength(1);
    expect(transactions).toHaveLength(0);
  });

  it("writes every impression in a single insert", async () => {
    automationRows = [auto("a1", oneAction()), auto("a2", oneAction("show_toast"))];
    await service().evaluate(request());
    expect(insertsInto("automation_impressions")[0]!.rows).toHaveLength(2);
  });

  it("charges one impression per automation that fired", async () => {
    automationRows = [auto("a1", oneAction()), auto("a2", oneAction("show_toast"))];
    await service().evaluate(request());

    const rows = insertsInto("automation_impressions").flatMap((i) => i.rows) as Array<
      Record<string, unknown>
    >;
    expect(rows.map((r) => r.automationId).sort()).toEqual(["a1", "a2"]);
    expect(rows.every((r) => r.anonymousId === VISITOR && r.websiteId === WEBSITE)).toBe(true);
  });

  it("opens no transaction at all when nothing fired", async () => {
    automationRows = [automation("a1", { triggers: [{ type: "page_view" }], graph: oneAction() })];
    await service().evaluate(request());

    expect(transactions).toHaveLength(0);
    expect(insertsInto("outbox")).toHaveLength(0);
  });

  it("records the impression against the visitor and session that triggered it", async () => {
    automationRows = [auto("a1", oneAction())];
    await service().evaluate(request({ userId: "user_9" }));

    const [row] = insertsInto("automation_impressions").flatMap((i) => i.rows) as Array<
      Record<string, unknown>
    >;
    expect(row).toMatchObject({
      automationId: "a1",
      anonymousId: VISITOR,
      sessionId: SESSION,
      websiteId: WEBSITE,
      userId: "user_9",
    });
  });

  it("logs a server run row for each automation that fired", async () => {
    automationRows = [auto("a1", oneAction())];
    await service().evaluate(request());
    await flush();

    expect(eventRows("server_run")).toHaveLength(1);
    expect(eventRows("server_run")[0]).toMatchObject({
      automationId: "a1",
      triggerEvent: "exit_intent",
      visitorId: VISITOR,
      sessionId: SESSION,
      pageUrl: "/pricing",
    });
  });
});

// -- Multiple automations ----------------------------------------------------

describe("multiple automations", () => {
  it("evaluates every matching automation", async () => {
    automationRows = [auto("a1", oneAction()), auto("a2", oneAction("show_toast"))];
    expect((await service().evaluate(request())).matched).toBe(2);
  });

  it("preserves the repository's priority ordering", async () => {
    automationRows = [auto("high", oneAction()), auto("low", oneAction("show_toast"))];
    const out = await service().evaluate(request());
    expect(out.actions.map((a) => a.automation_id)).toEqual(["high", "low"]);
  });

  it("returns nothing when the website has no automations", async () => {
    automationRows = [];
    expect(await service().evaluate(request())).toEqual({ matched: 0, actions: [] });
  });
});

// -- A/B variants ------------------------------------------------------------

describe("A/B variants", () => {
  const ab = (variants: Array<{ id: string; weight?: number }>, enabled = true) => ({
    abTest: { enabled, variants },
  });

  it("assigns no variant when no test is configured", async () => {
    automationRows = [auto("a1", oneAction())];
    expect((await service().evaluate(request())).actions[0]!.variant).toBeNull();
  });

  it("assigns no variant when the test is disabled", async () => {
    automationRows = [auto("a1", oneAction(), ab([{ id: "a" }], false))];
    expect((await service().evaluate(request())).actions[0]!.variant).toBeNull();
  });

  it("always picks the only variant of a single-variant test", async () => {
    automationRows = [auto("a1", oneAction(), ab([{ id: "only" }]))];
    expect((await service().evaluate(request())).actions[0]!.variant).toBe("only");
  });

  it("only ever picks a declared variant", async () => {
    automationRows = [auto("a1", oneAction(), ab([{ id: "a", weight: 1 }, { id: "b", weight: 1 }]))];
    for (let i = 0; i < 30; i++) {
      const out = await service().evaluate(request());
      expect(["a", "b"]).toContain(String(out.actions[0]!.variant));
    }
  });

  it("never picks a zero-weight variant when another has weight", async () => {
    automationRows = [
      auto("a1", oneAction(), ab([{ id: "off", weight: 0 }, { id: "on", weight: 10 }])),
    ];
    for (let i = 0; i < 30; i++) {
      expect((await service().evaluate(request())).actions[0]!.variant).toBe("on");
    }
  });

  it("records the assigned variant on the impression", async () => {
    automationRows = [auto("a1", oneAction(), ab([{ id: "only" }]))];
    await service().evaluate(request());

    const [row] = insertsInto("automation_impressions").flatMap((i) => i.rows) as Array<
      Record<string, unknown>
    >;
    expect(row!.variant).toBe("only");
  });

  it("gives every action of one run the same variant", async () => {
    automationRows = [
      auto(
        "a1",
        { entry: "a", nodes: [act("a", "show_banner"), act("b", "show_toast")], edges: [edge("a", "b")] },
        ab([{ id: "a" }, { id: "b" }]),
      ),
    ];
    const out = await service().evaluate(request());
    expect(new Set(out.actions.map((a) => a.variant)).size).toBe(1);
  });
});

// -- Condition context -------------------------------------------------------

describe("condition context", () => {
  it("exposes the trigger payload under `trigger`", async () => {
    automationRows = [
      automation("a1", {
        triggers: [{ type: "custom_event" }],
        graph: {
          entry: "if1",
          nodes: [ifNode("if1", "trigger.name", "signup"), act("a", "show_banner")],
          edges: [edge("if1", "a", "true")],
        },
      }),
    ];
    const out = await service().evaluate(
      request({ trigger: { type: "custom_event", name: "signup" } }),
    );
    expect(out.matched).toBe(1);
  });

  it("exposes the session id under session.id", async () => {
    automationRows = [
      auto("a1", {
        entry: "if1",
        nodes: [ifNode("if1", "session.id", SESSION), act("a", "show_banner")],
        edges: [edge("if1", "a", "true")],
      }),
    ];
    expect((await service().evaluate(request())).matched).toBe(1);
  });

  it("lets request context override profile facts of the same name", async () => {
    automationRows = [
      auto("a1", {
        entry: "if1",
        nodes: [ifNode("if1", "country", "BD"), act("a", "show_banner")],
        edges: [edge("if1", "a", "true")],
      }),
    ];
    const out = await service().evaluate(request({ context: { page: "/pricing", country: "BD" } }));
    expect(out.matched).toBe(1);
  });
});
