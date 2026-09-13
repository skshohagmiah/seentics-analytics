import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { fakeDbModule, fakeLogger, insertsInto, resetDb } from "./helpers/fake-db";
import type { EvaluateRequest } from "../interfaces";
import type { AutomationGraph, GraphNode } from "../lib/automation-graph";
import { TRIGGER_TYPES, CLIENT_ACTION_TYPES } from "../validators/automation.schema";
import { OPERATORS, UNARY_OPERATORS, evaluateConditions, type Operator } from "../lib/automation-condition-evaluator";

/**
 * Every node the builder can place, exercised one at a time.
 *
 * The other files test the pipeline; this one tests the vocabulary. An automation is
 * assembled from three palettes - trigger types, condition operators, action types -
 * and each entry is a contract between a builder dropdown and a server branch. When
 * those drift nothing errors: the automation simply never fires, or fires for everyone.
 * So each palette is enumerated as a table, and a coverage test asserts the table is
 * exhaustive against the exported palette rather than merely long.
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

const act = (type: string, config: Record<string, unknown> = {}): GraphNode => ({
  id: "a",
  kind: "action",
  action: { type, ...config },
});

/** A one-node graph wrapping a single action. */
const graphOf = (node: GraphNode): AutomationGraph => ({ entry: node.id, nodes: [node], edges: [] });

function request(over: Partial<EvaluateRequest> = {}): EvaluateRequest {
  return {
    websiteId: WEBSITE,
    anonymousId: "anon_1",
    sessionId: "sess_1",
    trigger: { type: "exit_intent" },
    context: {},
    ...over,
  };
}

function service() {
  return new AutomationEvaluationService({
    listActiveAutomationsByPriority: listActive as never,
    executeWebhook: executeWebhook as never,
  });
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function actionRows(): Array<Record<string, unknown>> {
  return (insertsInto("automation_events").flatMap((i) => i.rows) as Array<Record<string, unknown>>)
    .filter((r) => r.recordType === "action");
}

beforeEach(() => {
  resetDb();
  automationRows = [];
  listActive.mockClear();
  executeWebhook.mockClear();
});

// == TRIGGERS ================================================================

/** Every trigger type, with the payload the tracker sends for it. */
const TRIGGERS: Array<{ type: string; payload: Record<string, unknown> }> = [
  { type: "page_view", payload: { url: "/pricing" } },
  { type: "click", payload: { selector: "#buy" } },
  { type: "scroll_depth", payload: { depth: 75 } },
  { type: "time_on_page", payload: { seconds: 30 } },
  { type: "exit_intent", payload: {} },
  { type: "inactivity", payload: { seconds: 60 } },
  { type: "rage_click", payload: { selector: "#broken" } },
  { type: "form_abandon", payload: { formId: "signup" } },
  { type: "js_error", payload: { message: "boom" } },
  { type: "tab_hidden", payload: {} },
  { type: "tab_visible", payload: {} },
  { type: "custom_event", payload: { name: "signup" } },
  { type: "identify", payload: { userId: "u1" } },
];

describe("trigger nodes", () => {
  for (const { type, payload } of TRIGGERS) {
    describe(type, () => {
      it("fires an automation configured for it", async () => {
        automationRows = [{ id: "a1", definition: { triggers: [{ type }], graph: graphOf(act("show_banner")) } }];
        const out = await service().evaluate(request({ trigger: { type, ...payload } }));
        expect(out.matched).toBe(1);
      });

      it("does not fire an automation configured for a different trigger", async () => {
        const other = type === "exit_intent" ? "page_view" : "exit_intent";
        automationRows = [
          { id: "a1", definition: { triggers: [{ type: other }], graph: graphOf(act("show_banner")) } },
        ];
        const out = await service().evaluate(request({ trigger: { type, ...payload } }));
        expect(out.matched).toBe(0);
      });

      it("records its type on the run log", async () => {
        automationRows = [{ id: "a1", definition: { triggers: [{ type }], graph: graphOf(act("show_banner")) } }];
        await service().evaluate(request({ trigger: { type, ...payload } }));
        await flush();

        const run = (insertsInto("automation_events").flatMap((i) => i.rows) as Array<
          Record<string, unknown>
        >).find((r) => r.recordType === "server_run");
        expect(run?.triggerEvent).toBe(type);
      });

      it("exposes its own payload to conditions", async () => {
        // The trigger is merged into the condition context under `trigger`, so a
        // checkpoint can gate on what the trigger carried, not only on the visitor.
        const [factKey, factValue] = Object.entries(payload)[0] ?? ["type", type];
        automationRows = [
          {
            id: "a1",
            definition: {
              triggers: [{ type }],
              graph: {
                entry: "if1",
                nodes: [
                  {
                    id: "if1",
                    kind: "if",
                    group: {
                      operator: "AND",
                      rules: [{ fact: `trigger.${factKey}`, operator: "equals", value: factValue }],
                    },
                  },
                  { id: "hit", kind: "action", action: { type: "show_banner" } },
                ],
                edges: [{ from: "if1", to: "hit", branch: "true" }],
              },
            },
          },
        ];
        const out = await service().evaluate(request({ trigger: { type, ...payload } }));
        expect(out.matched).toBe(1);
      });
    });
  }

  it("covers every trigger type the schema accepts", async () => {
    // `TRIGGER_TYPES` is what the builder renders its palette from and what the schema
    // validates against. An entry with no test is a trigger nobody has exercised.
    expect(TRIGGERS.map((t) => t.type).sort()).toEqual([...TRIGGER_TYPES].sort());
  });

  it("ignores a trigger type no automation declares", async () => {
    automationRows = [
      { id: "a1", definition: { triggers: [{ type: "page_view" }], graph: graphOf(act("show_banner")) } },
    ];
    expect((await service().evaluate(request({ trigger: { type: "not_real" } }))).matched).toBe(0);
  });
});

// == CONDITION OPERATORS =====================================================

/**
 * Every operator as a truth table.
 *
 * `pass` is a fact/value pair the operator must accept; `fail` one it must reject.
 * Writing both directions matters: an operator returning `true` unconditionally passes
 * any test that only checks the happy path, and an operator gating an automation is
 * exactly where that silently matters.
 */
const OPERATOR_CASES: Array<{
  op: Operator;
  pass: { fact: unknown; value?: unknown };
  fail: { fact: unknown; value?: unknown };
}> = [
  { op: "equals", pass: { fact: "a", value: "a" }, fail: { fact: "a", value: "b" } },
  { op: "notEquals", pass: { fact: "a", value: "b" }, fail: { fact: "a", value: "a" } },
  { op: "greaterThan", pass: { fact: 5, value: 3 }, fail: { fact: 3, value: 5 } },
  { op: "lessThan", pass: { fact: 3, value: 5 }, fail: { fact: 5, value: 3 } },
  { op: "greaterThanOrEqual", pass: { fact: 5, value: 5 }, fail: { fact: 4, value: 5 } },
  { op: "lessThanOrEqual", pass: { fact: 5, value: 5 }, fail: { fact: 6, value: 5 } },
  { op: "contains", pass: { fact: "hello world", value: "WORLD" }, fail: { fact: "hello", value: "zzz" } },
  { op: "notContains", pass: { fact: "hello", value: "zzz" }, fail: { fact: "hello world", value: "world" } },
  { op: "startsWith", pass: { fact: "/pricing", value: "/pri" }, fail: { fact: "/pricing", value: "/x" } },
  { op: "endsWith", pass: { fact: "/pricing", value: "ing" }, fail: { fact: "/pricing", value: "xyz" } },
  { op: "matches", pass: { fact: "abc123", value: "^abc" }, fail: { fact: "abc123", value: "^zzz" } },
  { op: "isSet", pass: { fact: "value" }, fail: { fact: "" } },
  { op: "isNotSet", pass: { fact: "" }, fail: { fact: "value" } },
  { op: "isTrue", pass: { fact: true }, fail: { fact: false } },
  { op: "isFalse", pass: { fact: false }, fail: { fact: true } },
  { op: "in", pass: { fact: "b", value: ["a", "b"] }, fail: { fact: "z", value: ["a", "b"] } },
  { op: "notIn", pass: { fact: "z", value: ["a", "b"] }, fail: { fact: "b", value: ["a", "b"] } },
];

describe("condition operator nodes", () => {
  function evalOne(op: string, fact: unknown, value: unknown): boolean {
    return evaluateConditions(
      { operator: "AND", rules: [{ fact: "x", operator: op as Operator, value }] },
      { x: fact },
    );
  }

  for (const { op, pass, fail } of OPERATOR_CASES) {
    describe(op, () => {
      it("accepts a matching value", () => {
        expect(evalOne(op, pass.fact, pass.value)).toBe(true);
      });

      it("rejects a non-matching value", () => {
        expect(evalOne(op, fail.fact, fail.value)).toBe(false);
      });

      it("does not throw on a fact that is not in the context", () => {
        expect(() =>
          evaluateConditions(
            { operator: "AND", rules: [{ fact: "absent.path", operator: op, value: pass.value }] },
            {},
          ),
        ).not.toThrow();
      });

      if (!UNARY_OPERATORS.includes(op)) {
        it("takes a right-hand value", () => {
          expect(pass).toHaveProperty("value");
        });
      }
    });
  }

  it("covers every operator the palette advertises", () => {
    // An operator in the dropdown with no branch produces a rule that fails closed, so
    // the automation silently never fires.
    expect(OPERATOR_CASES.map((c) => c.op).sort()).toEqual([...OPERATORS].sort());
  });

  it("gates a chain on the operator's verdict", async () => {
    // The truth table above tests the evaluator; this checks the wiring - a rule that
    // fails really does stop the chain.
    automationRows = [
      {
        id: "a1",
        definition: {
          triggers: [{ type: "exit_intent" }],
          graph: {
            entry: "if1",
            nodes: [
              { id: "if1", kind: "if", group: { operator: "AND", rules: [{ fact: "plan", operator: "equals", value: "pro" }] } },
              { id: "hit", kind: "action", action: { type: "show_banner" } },
            ],
            edges: [{ from: "if1", to: "hit", branch: "true" }],
          },
        },
      },
    ];
    expect((await service().evaluate(request({ context: { plan: "pro" } }))).matched).toBe(1);
    expect((await service().evaluate(request({ context: { plan: "free" } }))).matched).toBe(0);
  });
});

// == ACTIONS =================================================================

/** Every client action, with a representative configuration. */
const CLIENT_ACTIONS: Array<{ type: string; config: Record<string, unknown> }> = [
  { type: "show_modal", config: { title: "Wait!", body: "Stay a while" } },
  { type: "show_toast", config: { message: "Saved" } },
  { type: "show_banner", config: { text: "10% off", position: "top" } },
  { type: "highlight_element", config: { selector: "#buy" } },
  { type: "show_tooltip", config: { selector: "#buy", text: "Click here" } },
  { type: "personalize_content", config: { selector: "h1", html: "<b>Hi</b>" } },
  { type: "redirect", config: { url: "https://example.com/offer" } },
  { type: "tag_session", config: { tag: "high_intent" } },
];

describe("action nodes", () => {
  for (const { type, config } of CLIENT_ACTIONS) {
    describe(type, () => {
      it("is returned to the tracker with its configuration intact", async () => {
        automationRows = [
          { id: "a1", definition: { triggers: [{ type: "exit_intent" }], graph: graphOf(act(type, config)) } },
        ];
        const out = await service().evaluate(request());

        expect(out.actions).toHaveLength(1);
        expect(out.actions[0]).toMatchObject({ type, ...config, automation_id: "a1" });
      });

      it("is logged as a successful action", async () => {
        automationRows = [
          { id: "a1", definition: { triggers: [{ type: "exit_intent" }], graph: graphOf(act(type, config)) } },
        ];
        await service().evaluate(request());
        await flush();

        expect(actionRows()).toHaveLength(1);
        expect(actionRows()[0]).toMatchObject({ status: "success", actionKey: `${type}_0` });
      });

      it("does not reach the webhook executor", async () => {
        automationRows = [
          { id: "a1", definition: { triggers: [{ type: "exit_intent" }], graph: graphOf(act(type, config)) } },
        ];
        await service().evaluate(request());
        await flush();
        expect(executeWebhook).not.toHaveBeenCalled();
      });

      it("renders templates in its configuration against the context", async () => {
        automationRows = [
          {
            id: "a1",
            definition: {
              triggers: [{ type: "exit_intent" }],
              graph: graphOf(act(type, { ...config, label: "Hi {{ user.name }}" })),
            },
          },
        ];
        const out = await service().evaluate(request({ context: { user: { name: "Ada" } } }));
        expect(out.actions[0]!.label).toBe("Hi Ada");
      });

      it("carries a preceding delay as delay_ms", async () => {
        automationRows = [
          {
            id: "a1",
            definition: {
              triggers: [{ type: "exit_intent" }],
              graph: {
                entry: "d",
                nodes: [
                  { id: "d", kind: "delay", seconds: 4 },
                  { id: "a", kind: "action", action: { type, ...config } },
                ],
                edges: [{ from: "d", to: "a" }],
              },
            },
          },
        ];
        expect((await service().evaluate(request())).actions[0]!.delay_ms).toBe(4000);
      });
    });
  }

  describe("webhook", () => {
    const hook: GraphNode = { id: "h", kind: "action", action: { type: "webhook", url: "https://hooks.example.com/x" } };

    it("is dispatched server-side and withheld from the tracker", async () => {
      automationRows = [{ id: "a1", definition: { triggers: [{ type: "exit_intent" }], graph: graphOf(hook) } }];
      const out = await service().evaluate(request());
      await flush();

      expect(out.actions).toEqual([]);
      expect(executeWebhook).toHaveBeenCalledTimes(1);
    });

    it("is keyed by position so two webhooks stay distinguishable in the log", async () => {
      automationRows = [
        {
          id: "a1",
          definition: {
            triggers: [{ type: "exit_intent" }],
            graph: {
              entry: "h1",
              nodes: [
                { id: "h1", kind: "action", action: { type: "webhook", url: "https://hooks.example.com/a" } },
                { id: "h2", kind: "action", action: { type: "webhook", url: "https://hooks.example.com/b" } },
              ],
              edges: [{ from: "h1", to: "h2" }],
            },
          },
        },
      ];
      await service().evaluate(request());
      await flush();
      expect(actionRows().map((r) => r.actionKey)).toEqual(["webhook_0", "webhook_1"]);
    });
  });

  it("covers every client action type the schema accepts", async () => {
    expect(CLIENT_ACTIONS.map((a) => a.type).sort()).toEqual([...CLIENT_ACTION_TYPES].sort());
  });

  it("keys repeated types by index so the log stays unambiguous", async () => {
    automationRows = [
      {
        id: "a1",
        definition: {
          triggers: [{ type: "exit_intent" }],
          graph: {
            entry: "t1",
            nodes: [
              { id: "t1", kind: "action", action: { type: "show_toast" } },
              { id: "t2", kind: "action", action: { type: "show_toast" } },
            ],
            edges: [{ from: "t1", to: "t2" }],
          },
        },
      },
    ];
    await service().evaluate(request());
    await flush();
    expect(actionRows().map((r) => r.actionKey)).toEqual(["show_toast_0", "show_toast_1"]);
  });

  it("mixes client and server actions in one chain, preserving order", async () => {
    automationRows = [
      {
        id: "a1",
        definition: {
          triggers: [{ type: "exit_intent" }],
          graph: {
            entry: "b",
            nodes: [
              { id: "b", kind: "action", action: { type: "show_banner" } },
              { id: "h", kind: "action", action: { type: "webhook", url: "https://hooks.example.com/x" } },
              { id: "t", kind: "action", action: { type: "show_toast" } },
            ],
            edges: [{ from: "b", to: "h" }, { from: "h", to: "t" }],
          },
        },
      },
    ];
    const out = await service().evaluate(request());
    await flush();

    expect(out.actions.map((a) => a.type)).toEqual(["show_banner", "show_toast"]);
    expect(executeWebhook).toHaveBeenCalledTimes(1);
  });
});
