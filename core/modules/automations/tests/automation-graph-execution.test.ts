import { describe, expect, it } from "bun:test";
import { walkGraph } from "../services/automation-graph-execution.service";
import type { AutomationGraph, GraphNode } from "../lib/automation-graph";

/**
 * Walking the graph.
 *
 * Pure, so every branching question can be asked directly: which path a condition takes,
 * that a convergence node runs once, that delays accumulate along the route actually
 * walked rather than across the whole graph, and that a wait hands the remainder to the
 * browser with both outcomes precomputed.
 */

const group = (fact: string, value: unknown) => ({
  operator: "AND" as const,
  rules: [{ fact, operator: "equals" as const, value }],
});

const action = (id: string, type: string): GraphNode => ({ id, kind: "action", action: { type } });
const webhook = (id: string, url = "https://hooks.test/x"): GraphNode => ({
  id,
  kind: "action",
  action: { type: "webhook", url },
});
const delay = (id: string, seconds: number): GraphNode => ({ id, kind: "delay", seconds });
const ifNode = (id: string, fact: string, value: unknown): GraphNode => ({
  id,
  kind: "if",
  group: group(fact, value),
});
const waitNode = (id: string, fact: string, value: unknown, timeoutSeconds = 30): GraphNode => ({
  id,
  kind: "wait_until",
  group: group(fact, value),
  timeoutSeconds,
});
const edge = (from: string, to: string, branch?: string) => ({ from, to, branch });

const types = (r: { actions: Array<{ type: string }> }) => r.actions.map((a) => a.type);

// -- Linear ------------------------------------------------------------------

describe("linear paths", () => {
  it("returns a single action", () => {
    const g: AutomationGraph = { entry: "a", nodes: [action("a", "show_banner")], edges: [] };
    expect(types(walkGraph(g, {}))).toEqual(["show_banner"]);
  });

  it("follows successors in order", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a", "show_banner"), action("b", "show_toast"), action("c", "redirect")],
      edges: [edge("a", "b"), edge("b", "c")],
    };
    expect(types(walkGraph(g, {}))).toEqual(["show_banner", "show_toast", "redirect"]);
  });

  it("stops at a node with no successor", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a", "show_banner"), action("orphan", "show_toast")],
      edges: [],
    };
    expect(types(walkGraph(g, {}))).toEqual(["show_banner"]);
  });

  it("separates webhooks from client actions, keeping each in order", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a", "show_banner"), webhook("h"), action("b", "show_toast")],
      edges: [edge("a", "h"), edge("h", "b")],
    };
    const out = walkGraph(g, {});
    expect(types(out)).toEqual(["show_banner", "show_toast"]);
    expect(out.webhooks).toHaveLength(1);
  });
});

// -- if / else ---------------------------------------------------------------

describe("if/else", () => {
  function branching(): AutomationGraph {
    return {
      entry: "if1",
      nodes: [ifNode("if1", "plan", "pro"), action("yes", "show_toast"), action("no", "show_banner")],
      edges: [edge("if1", "yes", "true"), edge("if1", "no", "false")],
    };
  }

  it("takes the true branch when the condition passes", () => {
    expect(types(walkGraph(branching(), { plan: "pro" }))).toEqual(["show_toast"]);
  });

  it("takes the false branch when it fails", () => {
    expect(types(walkGraph(branching(), { plan: "free" }))).toEqual(["show_banner"]);
  });

  it("takes the false branch when the fact is absent", () => {
    expect(types(walkGraph(branching(), {}))).toEqual(["show_banner"]);
  });

  it("runs only the branch it took", () => {
    const out = walkGraph(branching(), { plan: "pro" });
    expect(out.actions).toHaveLength(1);
  });

  it("ends the run when the chosen branch is unconnected", () => {
    const g: AutomationGraph = {
      entry: "if1",
      nodes: [ifNode("if1", "plan", "pro"), action("yes", "show_toast")],
      edges: [edge("if1", "yes", "true")],
    };
    expect(walkGraph(g, { plan: "free" }).actions).toEqual([]);
  });

  it("nests to any depth", () => {
    const g: AutomationGraph = {
      entry: "if1",
      nodes: [
        ifNode("if1", "a", "1"),
        ifNode("if2", "b", "2"),
        action("deep", "redirect"),
        action("shallow", "show_toast"),
        action("other", "show_banner"),
      ],
      edges: [
        edge("if1", "if2", "true"),
        edge("if1", "other", "false"),
        edge("if2", "deep", "true"),
        edge("if2", "shallow", "false"),
      ],
    };
    expect(types(walkGraph(g, { a: "1", b: "2" }))).toEqual(["redirect"]);
    expect(types(walkGraph(g, { a: "1", b: "9" }))).toEqual(["show_toast"]);
    expect(types(walkGraph(g, { a: "9" }))).toEqual(["show_banner"]);
  });
});

// -- Convergence -------------------------------------------------------------

describe("convergence", () => {
  function diamond(): AutomationGraph {
    return {
      entry: "if1",
      nodes: [
        ifNode("if1", "plan", "pro"),
        action("yes", "show_toast"),
        action("no", "show_banner"),
        action("tail", "redirect"),
      ],
      edges: [
        edge("if1", "yes", "true"),
        edge("if1", "no", "false"),
        edge("yes", "tail"),
        edge("no", "tail"),
      ],
    };
  }

  it("reaches the shared tail from the true branch", () => {
    expect(types(walkGraph(diamond(), { plan: "pro" }))).toEqual(["show_toast", "redirect"]);
  });

  it("reaches the same tail from the false branch", () => {
    expect(types(walkGraph(diamond(), { plan: "free" }))).toEqual(["show_banner", "redirect"]);
  });

  it("runs the shared tail exactly once", () => {
    // The reason a DAG needs no visited set: only one branch is ever walked, so a node
    // both branches point at cannot execute twice.
    const out = walkGraph(diamond(), { plan: "pro" });
    expect(out.actions.filter((a) => a.type === "redirect")).toHaveLength(1);
  });
});

// -- switch ------------------------------------------------------------------

describe("switch", () => {
  function multiway(): AutomationGraph {
    return {
      entry: "s",
      nodes: [
        {
          id: "s",
          kind: "switch",
          cases: [
            { id: "enterprise", group: group("plan", "enterprise") },
            { id: "pro", group: group("plan", "pro") },
          ],
        },
        action("ent", "redirect"),
        action("pro", "show_toast"),
        action("rest", "show_banner"),
      ],
      edges: [
        edge("s", "ent", "enterprise"),
        edge("s", "pro", "pro"),
        edge("s", "rest", "default"),
      ],
    };
  }

  it("takes the branch of the matching case", () => {
    expect(types(walkGraph(multiway(), { plan: "pro" }))).toEqual(["show_toast"]);
    expect(types(walkGraph(multiway(), { plan: "enterprise" }))).toEqual(["redirect"]);
  });

  it("falls through to default when nothing matches", () => {
    expect(types(walkGraph(multiway(), { plan: "free" }))).toEqual(["show_banner"]);
    expect(types(walkGraph(multiway(), {}))).toEqual(["show_banner"]);
  });

  it("matches cases in declaration order, so an earlier case shadows a later one", () => {
    // What makes a switch readable top-to-bottom rather than a set of guards whose
    // precedence you have to work out.
    const g: AutomationGraph = {
      entry: "s",
      nodes: [
        {
          id: "s",
          kind: "switch",
          cases: [
            { id: "first", group: { operator: "AND", rules: [{ fact: "x", operator: "isSet" }] } },
            { id: "second", group: group("x", "hello") },
          ],
        },
        action("a", "show_toast"),
        action("b", "show_banner"),
        action("d", "redirect"),
      ],
      edges: [edge("s", "a", "first"), edge("s", "b", "second"), edge("s", "d", "default")],
    };
    expect(types(walkGraph(g, { x: "hello" }))).toEqual(["show_toast"]);
  });

  it("ends the run when the chosen case is unconnected", () => {
    const g: AutomationGraph = {
      entry: "s",
      nodes: [
        { id: "s", kind: "switch", cases: [{ id: "only", group: group("plan", "pro") }] },
        action("d", "show_banner"),
      ],
      edges: [edge("s", "d", "default")],
    };
    expect(walkGraph(g, { plan: "pro" }).actions).toEqual([]);
  });
});

// -- Delays ------------------------------------------------------------------

describe("delays", () => {
  it("gives an action with no preceding delay an offset of zero", () => {
    const g: AutomationGraph = { entry: "a", nodes: [action("a", "show_banner")], edges: [] };
    expect(walkGraph(g, {}).actions[0]!.delayMs).toBe(0);
  });

  it("offsets every action after a delay", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a", "show_banner"), delay("d", 5), action("b", "show_toast")],
      edges: [edge("a", "d"), edge("d", "b")],
    };
    const out = walkGraph(g, {});
    expect(out.actions.map((a) => a.delayMs)).toEqual([0, 5000]);
  });

  it("accumulates successive delays", () => {
    const g: AutomationGraph = {
      entry: "d1",
      nodes: [delay("d1", 2), action("a", "show_banner"), delay("d2", 3), action("b", "show_toast")],
      edges: [edge("d1", "a"), edge("a", "d2"), edge("d2", "b")],
    };
    expect(walkGraph(g, {}).actions.map((a) => a.delayMs)).toEqual([2000, 5000]);
  });

  it("counts only the delays on the branch actually taken", () => {
    // The budget follows the route, not the graph — a delay on the branch not taken
    // must not push the actions that did run further out.
    const g: AutomationGraph = {
      entry: "if1",
      nodes: [
        ifNode("if1", "plan", "pro"),
        delay("slow", 60),
        action("yes", "show_toast"),
        action("no", "show_banner"),
      ],
      edges: [
        edge("if1", "slow", "true"),
        edge("if1", "no", "false"),
        edge("slow", "yes"),
      ],
    };
    expect(walkGraph(g, { plan: "pro" }).actions[0]!.delayMs).toBe(60_000);
    expect(walkGraph(g, { plan: "free" }).actions[0]!.delayMs).toBe(0);
  });

  it("ignores a negative delay rather than pulling actions earlier", () => {
    const g: AutomationGraph = {
      entry: "d",
      nodes: [delay("d", -10), action("a", "show_banner")],
      edges: [edge("d", "a")],
    };
    expect(walkGraph(g, {}).actions[0]!.delayMs).toBe(0);
  });

  it("does not offset a webhook - the server sends it now", () => {
    const g: AutomationGraph = {
      entry: "d",
      nodes: [delay("d", 5), webhook("h")],
      edges: [edge("d", "h")],
    };
    const out = walkGraph(g, {});
    expect(out.webhooks).toHaveLength(1);
    expect(out.webhooks[0]).not.toHaveProperty("delayMs");
  });
});

// -- wait_until --------------------------------------------------------------

describe("wait_until", () => {
  function waiting(): AutomationGraph {
    return {
      entry: "w",
      nodes: [waitNode("w", "scrolled", "true", 30), action("met", "show_toast"), action("out", "show_banner")],
      edges: [edge("w", "met", "met"), edge("w", "out", "timeout")],
    };
  }

  it("hands the remainder to the browser rather than resolving it", () => {
    // The server cannot pause: it has to answer the tracker's request now.
    const out = walkGraph(waiting(), {});
    expect(out.continuation).toBeDefined();
    expect(out.actions).toEqual([]);
  });

  it("precomputes both outcomes so the page needs no second round trip", () => {
    const c = walkGraph(waiting(), {}).continuation!;
    expect(c.met.map((a) => a.type)).toEqual(["show_toast"]);
    expect(c.timeout.map((a) => a.type)).toEqual(["show_banner"]);
  });

  it("carries the condition and timeout for the page to re-evaluate", () => {
    const c = walkGraph(waiting(), {}).continuation!;
    expect(c.timeoutMs).toBe(30_000);
    expect(c.group).toEqual(group("scrolled", "true"));
  });

  it("records the offset at which the wait begins", () => {
    const g: AutomationGraph = {
      entry: "d",
      nodes: [delay("d", 4), waitNode("w", "x", "1"), action("a", "show_toast"), action("b", "show_banner")],
      edges: [edge("d", "w"), edge("w", "a", "met"), edge("w", "b", "timeout")],
    };
    expect(walkGraph(g, {}).continuation!.startMs).toBe(4000);
  });

  it("keeps actions resolved before the wait on the main list", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a", "show_banner"), waitNode("w", "x", "1"), action("m", "show_toast"), action("t", "redirect")],
      edges: [edge("a", "w"), edge("w", "m", "met"), edge("w", "t", "timeout")],
    };
    const out = walkGraph(g, {});
    expect(types(out)).toEqual(["show_banner"]);
    expect(out.continuation!.met.map((a) => a.type)).toEqual(["show_toast"]);
  });

  it("keeps a webhook before the wait, and sends it now", () => {
    const g: AutomationGraph = {
      entry: "h",
      nodes: [webhook("h"), waitNode("w", "x", "1"), action("m", "show_toast"), action("t", "redirect")],
      edges: [edge("h", "w"), edge("w", "m", "met"), edge("w", "t", "timeout")],
    };
    expect(walkGraph(g, {}).webhooks).toHaveLength(1);
  });

  it("restarts the delay budget within each branch", () => {
    // The branch's own delays are relative to the wait resolving, not to the run start.
    const g: AutomationGraph = {
      entry: "w",
      nodes: [waitNode("w", "x", "1"), delay("d", 2), action("m", "show_toast"), action("t", "redirect")],
      edges: [edge("w", "d", "met"), edge("w", "t", "timeout"), edge("d", "m")],
    };
    expect(walkGraph(g, {}).continuation!.met[0]!.delayMs).toBe(2000);
  });

  it("nests a second wait inside a branch", () => {
    const g: AutomationGraph = {
      entry: "w1",
      nodes: [
        waitNode("w1", "a", "1"),
        waitNode("w2", "b", "2"),
        action("deep", "redirect"),
        action("x", "show_toast"),
        action("y", "show_banner"),
      ],
      edges: [
        edge("w1", "w2", "met"),
        edge("w1", "y", "timeout"),
        edge("w2", "deep", "met"),
        edge("w2", "x", "timeout"),
      ],
    };
    const c = walkGraph(g, {}).continuation!;
    expect(c.metContinuation).toBeDefined();
    expect(c.metContinuation!.met.map((a) => a.type)).toEqual(["redirect"]);
    expect(c.timeout.map((a) => a.type)).toEqual(["show_banner"]);
  });

  it("leaves a branch empty when it is unconnected", () => {
    const g: AutomationGraph = {
      entry: "w",
      nodes: [waitNode("w", "x", "1"), action("m", "show_toast")],
      edges: [edge("w", "m", "met")],
    };
    expect(walkGraph(g, {}).continuation!.timeout).toEqual([]);
  });
});

// -- Robustness --------------------------------------------------------------

describe("robustness", () => {
  it("stops rather than looping on a hand-edited cyclic graph", () => {
    // Cycles are refused at save time, so this is a backstop against a definition
    // written straight to the database.
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a", "show_banner"), action("b", "show_toast")],
      edges: [edge("a", "b"), edge("b", "a")],
    };
    const out = walkGraph(g, {});
    expect(out.actions.length).toBeLessThanOrEqual(102);
  });

  it("returns nothing for an entry that names no node", () => {
    const g: AutomationGraph = { entry: "ghost", nodes: [action("a", "show_banner")], edges: [] };
    expect(walkGraph(g, {})).toEqual({ actions: [], webhooks: [] });
  });

  it("returns nothing for an empty graph", () => {
    expect(walkGraph({ entry: "a", nodes: [], edges: [] }, {})).toEqual({ actions: [], webhooks: [] });
  });

  it("carries an action's own configuration through", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [{ id: "a", kind: "action", action: { type: "show_modal", title: "Hi", body: "There" } }],
      edges: [],
    };
    expect(walkGraph(g, {}).actions[0]).toMatchObject({ type: "show_modal", title: "Hi", body: "There" });
  });
});
