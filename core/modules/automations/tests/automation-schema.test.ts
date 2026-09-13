import { describe, expect, it } from "bun:test";
import {
  automationDefinitionSchema,
  automationsBulkDeleteSchema,
  automationsPatchBodySchema,
  automationsUpsertBodySchema,
  CLIENT_ACTION_TYPES,
  TRIGGER_TYPES,
} from "../validators/automation.schema";
import { MAX_DELAY_SECONDS, MAX_NODES } from "../lib/automation-graph";
import { OPERATORS } from "../lib/automation-condition-evaluator";

/**
 * Definition validation.
 *
 * The definition is an executable document: it names webhook URLs the server will call
 * and conditions that decide who sees what. So this is not shape-checking for its own
 * sake - it is the last point at which a malformed automation can be refused with a
 * message someone can act on, rather than discovered as silence at evaluate time.
 */

const SAFE_URL = "https://hooks.example.com/inbound";

const node = (id: string, type = "show_banner", config: Record<string, unknown> = {}) => ({
  id,
  kind: "action" as const,
  action: { type, ...config },
});
const hookNode = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "action" as const,
  action: { type: "webhook", url: SAFE_URL, ...over },
});
const ifN = (id: string, rules: unknown[] = [{ fact: "page", operator: "equals", value: "/x" }]) => ({
  id,
  kind: "if" as const,
  group: { operator: "AND" as const, rules },
});
const delayN = (id: string, seconds: number) => ({ id, kind: "delay" as const, seconds });
const waitN = (id: string, timeoutSeconds = 30) => ({
  id,
  kind: "wait_until" as const,
  group: { operator: "AND" as const, rules: [{ fact: "x", operator: "isSet" }] },
  timeoutSeconds,
});
const switchN = (id: string, cases = 2) => ({
  id,
  kind: "switch" as const,
  cases: Array.from({ length: cases }, (_, i) => ({
    id: `c${i}`,
    label: `Case ${i}`,
    group: { operator: "AND" as const, rules: [{ fact: "x", operator: "isSet" }] },
  })),
});
const edge = (from: string, to: string, branch?: string) => ({ from, to, branch });

/** The smallest valid graph. */
const oneAction = () => ({ entry: "a", nodes: [node("a")], edges: [] as unknown[] });

function definition(over: Record<string, unknown> = {}) {
  return { triggers: [{ type: "exit_intent" }], graph: oneAction(), ...over };
}

/** All issue messages, joined - enough to assert a specific complaint was raised. */
function errorsFor(def: unknown): string {
  const out = automationDefinitionSchema.safeParse(def);
  return out.success ? "" : out.error.issues.map((i) => i.message).join(" | ");
}

// -- Triggers ----------------------------------------------------------------

describe("triggers", () => {
  it("accepts every trigger type the tracker can emit", () => {
    for (const type of TRIGGER_TYPES) {
      expect(automationDefinitionSchema.safeParse(definition({ triggers: [{ type }] })).success).toBe(true);
    }
  });

  it("rejects a trigger type the tracker never sends", () => {
    // A typo here saves cleanly and then never fires, which is the failure this schema
    // exists to turn into a visible error.
    expect(errorsFor(definition({ triggers: [{ type: "on_tuesday" }] }))).toContain("Invalid");
  });

  it("requires at least one trigger", () => {
    expect(automationDefinitionSchema.safeParse(definition({ triggers: [] })).success).toBe(false);
    expect(automationDefinitionSchema.safeParse({ graph: oneAction() }).success).toBe(false);
  });

  it("accepts several triggers", () => {
    const def = definition({ triggers: [{ type: "exit_intent" }, { type: "page_view" }] });
    expect(automationDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it("caps the number of triggers", () => {
    const many = Array.from({ length: 11 }, () => ({ type: "click" }));
    expect(automationDefinitionSchema.safeParse(definition({ triggers: many })).success).toBe(false);
  });

  it("keeps a trigger's own configuration", () => {
    const out = automationDefinitionSchema.safeParse(
      definition({ triggers: [{ type: "scroll_depth", depth: 75 }] }),
    );
    expect(out.success).toBe(true);
    if (out.success) expect(out.data.triggers[0]).toMatchObject({ type: "scroll_depth", depth: 75 });
  });
});

// -- Graph -------------------------------------------------------------------

describe("graph", () => {
  it("accepts the smallest valid graph", () => {
    expect(automationDefinitionSchema.safeParse(definition()).success).toBe(true);
  });

  it("requires at least one node", () => {
    const def = definition({ graph: { entry: "a", nodes: [], edges: [] } });
    expect(automationDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("requires at least one reachable action", () => {
    const def = definition({
      graph: { entry: "d", nodes: [delayN("d", 5)], edges: [] },
    });
    expect(errorsFor(def)).toContain("at least one action");
  });

  it("caps the node count", () => {
    const nodes = Array.from({ length: MAX_NODES + 1 }, (_, i) => node(`n${i}`));
    const def = definition({ graph: { entry: "n0", nodes, edges: [] } });
    expect(automationDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects a node kind it does not know", () => {
    const def = definition({
      graph: { entry: "x", nodes: [{ id: "x", kind: "teleport" }], edges: [] },
    });
    expect(automationDefinitionSchema.safeParse(def).success).toBe(false);
  });

  describe("structure", () => {
    it("accepts a diamond, so branches may converge", () => {
      // The reason the model is a DAG rather than a tree: a shared tail is written once.
      const def = definition({
        graph: {
          entry: "if1",
          nodes: [ifN("if1"), node("yes", "show_toast"), node("no", "show_banner"), node("tail", "redirect")],
          edges: [
            edge("if1", "yes", "true"),
            edge("if1", "no", "false"),
            edge("yes", "tail"),
            edge("no", "tail"),
          ],
        },
      });
      expect(automationDefinitionSchema.safeParse(def).success).toBe(true);
    });

    it("rejects a loop", () => {
      const def = definition({
        graph: {
          entry: "a",
          nodes: [node("a"), node("b", "show_toast")],
          edges: [edge("a", "b"), edge("b", "a")],
        },
      });
      expect(errorsFor(def)).toContain("form a loop");
    });

    it("rejects an orphaned node", () => {
      const def = definition({
        graph: { entry: "a", nodes: [node("a"), node("orphan", "show_toast")], edges: [] },
      });
      expect(errorsFor(def)).toContain("not connected to anything");
    });

    it("rejects an edge pointing at a node that does not exist", () => {
      const def = definition({
        graph: { entry: "a", nodes: [node("a")], edges: [edge("a", "ghost")] },
      });
      expect(errorsFor(def)).toContain("does not exist");
    });

    it("rejects an entry that names no node", () => {
      const def = definition({ graph: { entry: "ghost", nodes: [node("a")], edges: [] } });
      expect(errorsFor(def)).toContain("no starting node");
    });

    it("reports graph problems against the graph path", () => {
      const out = automationDefinitionSchema.safeParse(
        definition({ graph: { entry: "a", nodes: [node("a"), node("orphan", "show_toast")], edges: [] } }),
      );
      expect(out.success).toBe(false);
      if (!out.success) expect(out.error.issues.some((i) => i.path.includes("graph"))).toBe(true);
    });
  });

  describe("branches", () => {
    it("accepts an if with both branches wired", () => {
      const def = definition({
        graph: {
          entry: "if1",
          nodes: [ifN("if1"), node("yes", "show_toast"), node("no", "show_banner")],
          edges: [edge("if1", "yes", "true"), edge("if1", "no", "false")],
        },
      });
      expect(automationDefinitionSchema.safeParse(def).success).toBe(true);
    });

    it("rejects an if with a branch wired to nothing", () => {
      const def = definition({
        graph: {
          entry: "if1",
          nodes: [ifN("if1"), node("yes", "show_toast")],
          edges: [edge("if1", "yes", "true")],
        },
      });
      expect(errorsFor(def)).toContain('nothing connected to its "false" branch');
    });

    it("accepts a switch with every case and its default wired", () => {
      const def = definition({
        graph: {
          entry: "s",
          nodes: [switchN("s", 2), node("a"), node("b", "show_toast"), node("d", "redirect")],
          edges: [edge("s", "a", "c0"), edge("s", "b", "c1"), edge("s", "d", "default")],
        },
      });
      expect(automationDefinitionSchema.safeParse(def).success).toBe(true);
    });

    it("rejects a switch with no cases", () => {
      const def = definition({
        graph: {
          entry: "s",
          nodes: [{ id: "s", kind: "switch", cases: [] }, node("d")],
          edges: [edge("s", "d", "default")],
        },
      });
      expect(automationDefinitionSchema.safeParse(def).success).toBe(false);
    });

    it("rejects an unlabelled connection leaving a branch node", () => {
      const def = definition({
        graph: { entry: "if1", nodes: [ifN("if1"), node("a")], edges: [edge("if1", "a")] },
      });
      expect(errorsFor(def)).toContain("unlabelled connection");
    });

    it("rejects a second successor on a linear node", () => {
      const def = definition({
        graph: {
          entry: "a",
          nodes: [node("a"), node("b", "show_toast"), node("c", "redirect")],
          edges: [edge("a", "b"), edge("a", "c")],
        },
      });
      expect(errorsFor(def)).toContain("more than one outgoing connection");
    });
  });

  describe("timing", () => {
    const withDelay = (seconds: number) =>
      definition({
        graph: { entry: "d", nodes: [delayN("d", seconds), node("a")], edges: [edge("d", "a")] },
      });

    it("rejects a non-positive or oversized delay", () => {
      expect(automationDefinitionSchema.safeParse(withDelay(0)).success).toBe(false);
      expect(automationDefinitionSchema.safeParse(withDelay(MAX_DELAY_SECONDS + 1)).success).toBe(false);
    });

    it("accepts a delay exactly at the maximum", () => {
      expect(automationDefinitionSchema.safeParse(withDelay(MAX_DELAY_SECONDS)).success).toBe(true);
    });

    it("budgets delays per route rather than across the graph", () => {
      // Two branches each waiting 200s is fine — no single visitor waits 400s.
      const half = MAX_DELAY_SECONDS - 100;
      const def = definition({
        graph: {
          entry: "if1",
          nodes: [ifN("if1"), delayN("d1", half), delayN("d2", half), node("a"), node("b", "show_toast")],
          edges: [
            edge("if1", "d1", "true"),
            edge("if1", "d2", "false"),
            edge("d1", "a"),
            edge("d2", "b"),
          ],
        },
      });
      expect(automationDefinitionSchema.safeParse(def).success).toBe(true);
    });

    it("rejects one route that waits past the budget", () => {
      const def = definition({
        graph: {
          entry: "d1",
          nodes: [delayN("d1", 200), delayN("d2", 200), node("a")],
          edges: [edge("d1", "d2"), edge("d2", "a")],
        },
      });
      expect(errorsFor(def)).toContain("the limit is");
    });
  });

  describe("waits", () => {
    it("accepts a wait with both branches wired", () => {
      const def = definition({
        graph: {
          entry: "w",
          nodes: [waitN("w"), node("m", "show_toast"), node("t", "show_banner")],
          edges: [edge("w", "m", "met"), edge("w", "t", "timeout")],
        },
      });
      expect(automationDefinitionSchema.safeParse(def).success).toBe(true);
    });

    it("accepts a webhook before a wait", () => {
      const def = definition({
        graph: {
          entry: "h",
          nodes: [hookNode("h"), waitN("w"), node("m", "show_toast"), node("t", "show_banner")],
          edges: [edge("h", "w"), edge("w", "m", "met"), edge("w", "t", "timeout")],
        },
      });
      expect(automationDefinitionSchema.safeParse(def).success).toBe(true);
    });

    it("rejects a webhook after a wait, explaining why", () => {
      // The server has already answered the tracker by the time the wait resolves, so a
      // webhook there would simply never be sent.
      const def = definition({
        graph: {
          entry: "w",
          nodes: [waitN("w"), hookNode("h"), node("t", "show_banner")],
          edges: [edge("w", "h", "met"), edge("w", "t", "timeout")],
        },
      });
      expect(errorsFor(def)).toContain("cannot come after a wait");
    });

    it("rejects a non-positive or oversized timeout", () => {
      for (const timeout of [0, -5, MAX_DELAY_SECONDS + 1]) {
        const def = definition({
          graph: {
            entry: "w",
            nodes: [waitN("w", timeout), node("m"), node("t", "show_toast")],
            edges: [edge("w", "m", "met"), edge("w", "t", "timeout")],
          },
        });
        expect(automationDefinitionSchema.safeParse(def).success).toBe(false);
      }
    });
  });
});

// -- Conditions --------------------------------------------------------------

describe("conditions", () => {
  const withRules = (rules: unknown[]) =>
    definition({
      graph: {
        entry: "if1",
        nodes: [ifN("if1", rules), node("a"), node("b", "show_toast")],
        edges: [edge("if1", "a", "true"), edge("if1", "b", "false")],
      },
    });

  it("accepts every operator the evaluator implements", () => {
    for (const operator of OPERATORS) {
      const def = withRules([{ fact: "x", operator, value: "y" }]);
      expect(automationDefinitionSchema.safeParse(def).success).toBe(true);
    }
  });

  it("rejects an operator the evaluator does not implement", () => {
    // Without this the rule saves and then fails closed forever, and the automation
    // silently takes the other branch every time.
    expect(automationDefinitionSchema.safeParse(withRules([{ fact: "x", operator: "sortaEquals", value: "y" }])).success).toBe(false);
  });

  it("rejects a rule with a missing or blank fact", () => {
    expect(automationDefinitionSchema.safeParse(withRules([{ operator: "isSet" }])).success).toBe(false);
    expect(automationDefinitionSchema.safeParse(withRules([{ fact: "   ", operator: "isSet" }])).success).toBe(false);
  });

  it("accepts nested groups", () => {
    const def = withRules([
      { fact: "a", operator: "isSet" },
      { operator: "OR", rules: [{ fact: "b", operator: "isSet" }] },
    ]);
    expect(automationDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it("rejects nesting past the depth limit", () => {
    // A hand-crafted definition must not be able to recurse the evaluator on the
    // unauthenticated tracker edge.
    let group: Record<string, unknown> = { operator: "AND", rules: [{ fact: "a", operator: "isSet" }] };
    for (let i = 0; i < 6; i++) group = { operator: "AND", rules: [group] };
    expect(errorsFor(withRules([group]))).toContain("nest more than");
  });
});

// -- Actions -----------------------------------------------------------------

describe("actions", () => {
  const withAction = (type: string, config: Record<string, unknown> = {}) =>
    definition({ graph: { entry: "a", nodes: [node("a", type, config)], edges: [] } });

  it("accepts every client action type the tracker can perform", () => {
    for (const type of CLIENT_ACTION_TYPES) {
      expect(automationDefinitionSchema.safeParse(withAction(type)).success).toBe(true);
    }
  });

  it("rejects an action type the tracker would silently ignore", () => {
    expect(automationDefinitionSchema.safeParse(withAction("send_pigeon")).success).toBe(false);
  });

  it("keeps a client action's own configuration", () => {
    const out = automationDefinitionSchema.safeParse(withAction("show_modal", { title: "Hi", body: "There" }));
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.graph.nodes[0]).toMatchObject({ action: { title: "Hi", body: "There" } });
    }
  });

  describe("webhook", () => {
    const withHook = (over: Record<string, unknown> = {}) =>
      definition({ graph: { entry: "h", nodes: [hookNode("h", over)], edges: [] } });

    it("accepts a public https endpoint and defaults the method to POST", () => {
      const out = automationDefinitionSchema.safeParse(withHook());
      expect(out.success).toBe(true);
      if (out.success) expect(out.data.graph.nodes[0]).toMatchObject({ action: { method: "POST" } });
    });

    it("rejects every internal or non-https target", () => {
      const blocked = [
        "https://169.254.169.254/latest/meta-data/",
        "https://localhost/hook",
        "https://127.0.0.1/hook",
        "https://10.0.0.5/hook",
        "https://host.docker.internal/hook",
        "https://payments.internal/hook",
        "http://hooks.example.com/inbound",
        "not-a-url",
      ];
      for (const url of blocked) {
        expect(automationDefinitionSchema.safeParse(withHook({ url })).success).toBe(false);
      }
    });

    it("rejects a forbidden header name, whatever its casing", () => {
      for (const header of ["Authorization", "cookie", "Host", "SET-COOKIE"]) {
        expect(automationDefinitionSchema.safeParse(withHook({ headers: { [header]: "x" } })).success).toBe(false);
      }
    });

    it("accepts an ordinary custom header", () => {
      expect(automationDefinitionSchema.safeParse(withHook({ headers: { "X-Api-Key": "secret" } })).success).toBe(true);
    });

    it("rejects an HTTP method outside the allow-list", () => {
      expect(automationDefinitionSchema.safeParse(withHook({ method: "TRACE" })).success).toBe(false);
    });

    it("accepts each allowed method", () => {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        expect(automationDefinitionSchema.safeParse(withHook({ method })).success).toBe(true);
      }
    });
  });
});

// -- Frequency and A/B -------------------------------------------------------

describe("frequency caps", () => {
  it("accepts each cap on its own", () => {
    for (const frequency of [{ maxPerSession: 1 }, { maxPerUser: 5 }, { cooldownDays: 7 }]) {
      expect(automationDefinitionSchema.safeParse(definition({ frequency })).success).toBe(true);
    }
  });

  it("accepts a cap of zero, which means never", () => {
    expect(automationDefinitionSchema.safeParse(definition({ frequency: { maxPerSession: 0 } })).success).toBe(true);
  });

  it("rejects a negative or fractional cap", () => {
    expect(automationDefinitionSchema.safeParse(definition({ frequency: { maxPerUser: -1 } })).success).toBe(false);
    expect(automationDefinitionSchema.safeParse(definition({ frequency: { maxPerUser: 1.5 } })).success).toBe(false);
  });

  it("rejects a cooldown longer than a year", () => {
    expect(automationDefinitionSchema.safeParse(definition({ frequency: { cooldownDays: 366 } })).success).toBe(false);
  });
});

describe("A/B test", () => {
  it("accepts a weighted two-variant test", () => {
    const abTest = { enabled: true, variants: [{ id: "a", weight: 1 }, { id: "b", weight: 3 }] };
    expect(automationDefinitionSchema.safeParse(definition({ abTest })).success).toBe(true);
  });

  it("rejects an enabled test with no variants", () => {
    // It could never pick one, so every run would be unassigned.
    const abTest = { enabled: true, variants: [] };
    expect(errorsFor(definition({ abTest }))).toContain("at least one variant");
  });

  it("allows a disabled test to carry no variants", () => {
    expect(automationDefinitionSchema.safeParse(definition({ abTest: { enabled: false, variants: [] } })).success).toBe(true);
  });

  it("rejects duplicate variant ids", () => {
    // Two arms with one name cannot be told apart in the impression log.
    const abTest = { enabled: true, variants: [{ id: "a" }, { id: "a" }] };
    expect(errorsFor(definition({ abTest }))).toContain("unique");
  });

  it("rejects a negative weight", () => {
    const abTest = { enabled: true, variants: [{ id: "a", weight: -1 }] };
    expect(automationDefinitionSchema.safeParse(definition({ abTest })).success).toBe(false);
  });
});

// -- Request bodies ----------------------------------------------------------

describe("upsert body", () => {
  it("requires a name and a definition", () => {
    expect(automationsUpsertBodySchema.safeParse({ name: "Welcome", definition: definition() }).success).toBe(true);
    expect(automationsUpsertBodySchema.safeParse({ definition: definition() }).success).toBe(false);
    expect(automationsUpsertBodySchema.safeParse({ name: "Welcome" }).success).toBe(false);
  });

  it("rejects an empty or over-long name", () => {
    expect(automationsUpsertBodySchema.safeParse({ name: "", definition: definition() }).success).toBe(false);
    expect(automationsUpsertBodySchema.safeParse({ name: "n".repeat(201), definition: definition() }).success).toBe(false);
  });

  it("validates the nested definition as strictly as on its own", () => {
    const body = { name: "Bad", definition: definition({ graph: { entry: "h", nodes: [hookNode("h", { url: "https://127.0.0.1/x" })], edges: [] } }) };
    expect(automationsUpsertBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("patch body", () => {
  it("accepts a rename with no definition", () => {
    // Renaming must not require resending the whole body.
    expect(automationsPatchBodySchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });

  it("accepts an enable/disable with nothing else", () => {
    expect(automationsPatchBodySchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it("still validates a definition that is supplied", () => {
    // Being a partial is not a licence to save a broken body.
    const patch = { definition: definition({ graph: { entry: "h", nodes: [hookNode("h", { url: "https://127.0.0.1/x" })], edges: [] } }) };
    expect(automationsPatchBodySchema.safeParse(patch).success).toBe(false);
  });

  it("accepts an empty patch", () => {
    expect(automationsPatchBodySchema.safeParse({}).success).toBe(true);
  });
});

describe("bulk delete body", () => {
  it("defaults to an empty id list", () => {
    expect(automationsBulkDeleteSchema.parse({})).toEqual({ ids: [] });
  });

  it("rejects a blank or over-long id", () => {
    expect(automationsBulkDeleteSchema.safeParse({ ids: [""] }).success).toBe(false);
    expect(automationsBulkDeleteSchema.safeParse({ ids: ["a".repeat(129)] }).success).toBe(false);
  });

  it("caps the batch at five hundred", () => {
    const ids = Array.from({ length: 501 }, (_, i) => `a${i}`);
    expect(automationsBulkDeleteSchema.safeParse({ ids }).success).toBe(false);
  });
});
