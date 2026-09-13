import { describe, expect, it } from "bun:test";
import {
  MAX_DELAY_SECONDS,
  MAX_SWITCH_CASES,
  edgeFor,
  findCycle,
  indexGraph,
  isBranchNode,
  outletsFor,
  pathsFrom,
  reachableFrom,
  type AutomationGraph,
  type GraphNode,
} from "../lib/automation-graph";
import { validateGraph } from "../lib/automation-graph-validation";

/**
 * The graph core.
 *
 * Everything a branching automation can get wrong is structural, and every one of those
 * is invisible on a canvas: an unreachable node, a branch wired to nothing, a loop, a
 * webhook stranded behind a wait. So the validator is the component under the most
 * pressure here, and each rule is tested with a graph that violates exactly it.
 */

const group = (fact = "page", value: unknown = "/x") => ({
  operator: "AND" as const,
  rules: [{ fact, operator: "equals" as const, value }],
});

const action = (id: string, type = "show_banner"): GraphNode => ({ id, kind: "action", action: { type } });
const webhook = (id: string): GraphNode => ({ id, kind: "action", action: { type: "webhook", url: "https://x.test" } });
const delay = (id: string, seconds = 5): GraphNode => ({ id, kind: "delay", seconds });
const ifNode = (id: string): GraphNode => ({ id, kind: "if", group: group() });
const switchNode = (id: string, cases = 2): GraphNode => ({
  id,
  kind: "switch",
  cases: Array.from({ length: cases }, (_, i) => ({ id: `c${i}`, label: `Case ${i}`, group: group() })),
});
const waitNode = (id: string, timeoutSeconds = 30): GraphNode => ({
  id,
  kind: "wait_until",
  group: group(),
  timeoutSeconds,
});

const edge = (from: string, to: string, branch?: string) => ({ from, to, branch });

/** The smallest valid graph: one action. */
function minimal(): AutomationGraph {
  return { entry: "a", nodes: [action("a")], edges: [] };
}

/** A diamond: if/else whose branches converge on a shared tail. */
function diamond(): AutomationGraph {
  return {
    entry: "if1",
    nodes: [ifNode("if1"), action("yes", "show_toast"), action("no", "show_banner"), action("tail", "redirect")],
    edges: [
      edge("if1", "yes", "true"),
      edge("if1", "no", "false"),
      edge("yes", "tail"),
      edge("no", "tail"),
    ],
  };
}

// -- Outlets -----------------------------------------------------------------

describe("outletsFor", () => {
  it("gives an if two branches", () => {
    expect(outletsFor(ifNode("x"))).toEqual(["true", "false"]);
  });

  it("gives a wait a met and a timeout branch", () => {
    expect(outletsFor(waitNode("x"))).toEqual(["met", "timeout"]);
  });

  it("gives a switch one branch per case plus a default", () => {
    expect(outletsFor(switchNode("x", 3))).toEqual(["c0", "c1", "c2", "default"]);
  });

  it("gives actions and delays a single unlabelled outlet", () => {
    expect(outletsFor(action("x"))).toBeNull();
    expect(outletsFor(delay("x"))).toBeNull();
  });

  it("identifies which kinds branch", () => {
    expect(isBranchNode(ifNode("x"))).toBe(true);
    expect(isBranchNode(switchNode("x"))).toBe(true);
    expect(isBranchNode(waitNode("x"))).toBe(true);
    expect(isBranchNode(action("x"))).toBe(false);
    expect(isBranchNode(delay("x"))).toBe(false);
  });
});

// -- Traversal ---------------------------------------------------------------

describe("edgeFor", () => {
  it("finds a labelled branch", () => {
    const { outgoing } = indexGraph(diamond());
    expect(edgeFor(outgoing, "if1", "true")?.to).toBe("yes");
    expect(edgeFor(outgoing, "if1", "false")?.to).toBe("no");
  });

  it("finds the unlabelled successor of a linear node", () => {
    const { outgoing } = indexGraph(diamond());
    expect(edgeFor(outgoing, "yes")?.to).toBe("tail");
  });

  it("returns undefined for an unconnected outlet", () => {
    const { outgoing } = indexGraph(diamond());
    expect(edgeFor(outgoing, "tail")).toBeUndefined();
    expect(edgeFor(outgoing, "if1", "nope")).toBeUndefined();
  });

  it("does not confuse an unlabelled lookup with a labelled edge", () => {
    const { outgoing } = indexGraph(diamond());
    expect(edgeFor(outgoing, "if1")).toBeUndefined();
  });
});

describe("reachableFrom", () => {
  it("includes the entry and everything downstream", () => {
    expect(reachableFrom(diamond(), "if1")).toEqual(new Set(["if1", "yes", "no", "tail"]));
  });

  it("reaches a convergence node once, through either branch", () => {
    expect(reachableFrom(diamond(), "if1").has("tail")).toBe(true);
  });

  it("excludes an orphan", () => {
    const g = diamond();
    g.nodes.push(action("orphan"));
    expect(reachableFrom(g, "if1").has("orphan")).toBe(false);
  });

  it("terminates on a cyclic graph rather than looping forever", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a"), action("b")],
      edges: [edge("a", "b"), edge("b", "a")],
    };
    expect(reachableFrom(g, "a")).toEqual(new Set(["a", "b"]));
  });
});

describe("findCycle", () => {
  it("returns null for an acyclic graph", () => {
    expect(findCycle(diamond())).toBeNull();
    expect(findCycle(minimal())).toBeNull();
  });

  it("returns null for a diamond - convergence is not a cycle", () => {
    // The distinction the whole DAG model rests on: two paths meeting is fine, a path
    // returning to itself is not.
    expect(findCycle(diamond())).toBeNull();
  });

  it("finds a two-node cycle", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a"), action("b")],
      edges: [edge("a", "b"), edge("b", "a")],
    };
    expect(findCycle(g)).toEqual(["a", "b", "a"]);
  });

  it("finds a self-loop", () => {
    const g: AutomationGraph = { entry: "a", nodes: [action("a")], edges: [edge("a", "a")] };
    expect(findCycle(g)).toEqual(["a", "a"]);
  });

  it("finds a cycle that does not include the entry", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a"), action("b"), action("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("c", "b")],
    };
    expect(findCycle(g)).toEqual(["b", "c", "b"]);
  });

  it("returns the nodes on the loop so the builder can highlight them", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a"), action("b"), action("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
    };
    expect(findCycle(g)).toEqual(["a", "b", "c", "a"]);
  });
});

describe("pathsFrom", () => {
  it("returns the single path of a linear graph", () => {
    const g: AutomationGraph = {
      entry: "a",
      nodes: [action("a"), action("b")],
      edges: [edge("a", "b")],
    };
    expect(pathsFrom(g, "a")).toEqual([["a", "b"]]);
  });

  it("returns one path per branch", () => {
    expect(pathsFrom(diamond(), "if1")).toEqual([
      ["if1", "yes", "tail"],
      ["if1", "no", "tail"],
    ]);
  });

  it("returns a single-node path for a lone entry", () => {
    expect(pathsFrom(minimal(), "a")).toEqual([["a"]]);
  });

  it("enumerates every route through nested branches", () => {
    const g: AutomationGraph = {
      entry: "if1",
      nodes: [ifNode("if1"), ifNode("if2"), action("a"), action("b"), action("c")],
      edges: [
        edge("if1", "if2", "true"),
        edge("if1", "c", "false"),
        edge("if2", "a", "true"),
        edge("if2", "b", "false"),
      ],
    };
    expect(pathsFrom(g, "if1")).toHaveLength(3);
  });
});

// -- Validation --------------------------------------------------------------

describe("validateGraph", () => {
  it("accepts the smallest useful graph", () => {
    expect(validateGraph(minimal())).toEqual([]);
  });

  it("accepts a diamond, so branches may converge", () => {
    // The whole point of choosing a DAG over a tree: a shared tail is written once.
    expect(validateGraph(diamond())).toEqual([]);
  });

  it("accepts a switch with every branch wired", () => {
    const g: AutomationGraph = {
      entry: "s",
      nodes: [switchNode("s", 2), action("a"), action("b"), action("d")],
      edges: [edge("s", "a", "c0"), edge("s", "b", "c1"), edge("s", "d", "default")],
    };
    expect(validateGraph(g)).toEqual([]);
  });

  describe("shape", () => {
    it("rejects an empty graph", () => {
      expect(validateGraph({ entry: "a", nodes: [], edges: [] })).toEqual(["Add at least one action."]);
    });

    it("rejects a malformed graph rather than throwing", () => {
      expect(validateGraph({ entry: "a", nodes: null, edges: [] } as never)).toEqual([
        "The automation graph is malformed.",
      ]);
    });

    it("rejects an entry that names no node", () => {
      const g: AutomationGraph = { entry: "missing", nodes: [action("a")], edges: [] };
      expect(validateGraph(g)).toContain("The automation has no starting node.");
    });

    it("rejects duplicate node ids", () => {
      const g: AutomationGraph = { entry: "a", nodes: [action("a"), action("a")], edges: [] };
      expect(validateGraph(g).join(" ")).toContain('share the id "a"');
    });

    it("rejects an edge pointing at a node that does not exist", () => {
      const g: AutomationGraph = { entry: "a", nodes: [action("a")], edges: [edge("a", "ghost")] };
      expect(validateGraph(g).join(" ")).toContain("points at a node that does not exist");
    });

    it("stops after a dangling edge rather than piling on derived errors", () => {
      // Every later check walks edges, so continuing would bury the real problem.
      const g: AutomationGraph = { entry: "a", nodes: [action("a")], edges: [edge("a", "ghost")] };
      expect(validateGraph(g)).toHaveLength(1);
    });
  });

  describe("outlets", () => {
    it("rejects a second successor on a linear node", () => {
      const g: AutomationGraph = {
        entry: "a",
        nodes: [action("a"), action("b"), action("c")],
        edges: [edge("a", "b"), edge("a", "c")],
      };
      expect(validateGraph(g).join(" ")).toContain("more than one outgoing connection");
    });

    it("rejects a labelled connection on a node with no branches", () => {
      const g: AutomationGraph = {
        entry: "a",
        nodes: [action("a"), action("b")],
        edges: [edge("a", "b", "true")],
      };
      expect(validateGraph(g).join(" ")).toContain("labelled connection but no branches");
    });

    it("rejects an unlabelled connection leaving a branch node", () => {
      const g: AutomationGraph = {
        entry: "if1",
        nodes: [ifNode("if1"), action("a")],
        edges: [edge("if1", "a")],
      };
      expect(validateGraph(g).join(" ")).toContain("unlabelled connection");
    });

    it("rejects a branch name the node does not have", () => {
      const g: AutomationGraph = {
        entry: "if1",
        nodes: [ifNode("if1"), action("a"), action("b")],
        edges: [edge("if1", "a", "true"), edge("if1", "b", "maybe")],
      };
      expect(validateGraph(g).join(" ")).toContain('no "maybe" branch');
    });

    it("rejects two connections on the same branch", () => {
      const g: AutomationGraph = {
        entry: "if1",
        nodes: [ifNode("if1"), action("a"), action("b"), action("c")],
        edges: [edge("if1", "a", "true"), edge("if1", "b", "true"), edge("if1", "c", "false")],
      };
      expect(validateGraph(g).join(" ")).toContain('two connections on its "true" branch');
    });

    it("reports a branch wired to nothing", () => {
      // Invisible on a busy canvas, and almost always an unfinished edit.
      const g: AutomationGraph = {
        entry: "if1",
        nodes: [ifNode("if1"), action("a")],
        edges: [edge("if1", "a", "true")],
      };
      expect(validateGraph(g).join(" ")).toContain('nothing connected to its "false" branch');
    });

    it("requires a switch to wire its default", () => {
      const g: AutomationGraph = {
        entry: "s",
        nodes: [switchNode("s", 1), action("a")],
        edges: [edge("s", "a", "c0")],
      };
      expect(validateGraph(g).join(" ")).toContain('nothing connected to its "default" branch');
    });

    it("rejects a switch with no cases", () => {
      const g: AutomationGraph = {
        entry: "s",
        nodes: [{ id: "s", kind: "switch", cases: [] }, action("a")],
        edges: [edge("s", "a", "default")],
      };
      expect(validateGraph(g)).toContain("A switch needs at least one case.");
    });

    it("rejects more cases than the cap", () => {
      const g: AutomationGraph = {
        entry: "s",
        nodes: [switchNode("s", MAX_SWITCH_CASES + 1)],
        edges: [],
      };
      expect(validateGraph(g).join(" ")).toContain(`more than ${MAX_SWITCH_CASES} cases`);
    });

    it("rejects duplicate case ids", () => {
      const g: AutomationGraph = {
        entry: "s",
        nodes: [
          { id: "s", kind: "switch", cases: [{ id: "dup", group: group() }, { id: "dup", group: group() }] },
        ],
        edges: [],
      };
      expect(validateGraph(g).join(" ")).toContain('two cases with the id "dup"');
    });
  });

  describe("cycles", () => {
    it("rejects a loop and names the nodes on it", () => {
      const g: AutomationGraph = {
        entry: "a",
        nodes: [action("a"), action("b")],
        edges: [edge("a", "b"), edge("b", "a")],
      };
      const errors = validateGraph(g);
      expect(errors.join(" ")).toContain("form a loop");
      expect(errors.join(" ")).toContain("a → b → a");
    });

    it("stops after a cycle rather than walking paths that never terminate", () => {
      const g: AutomationGraph = {
        entry: "a",
        nodes: [action("a"), action("b")],
        edges: [edge("a", "b"), edge("b", "a")],
      };
      expect(validateGraph(g)).toHaveLength(1);
    });
  });

  describe("reachability", () => {
    it("rejects an orphaned node", () => {
      const g = diamond();
      g.nodes.push(action("orphan", "show_toast"));
      expect(validateGraph(g).join(" ")).toContain("not connected to anything");
    });

    it("requires at least one reachable action", () => {
      const g: AutomationGraph = {
        entry: "if1",
        nodes: [ifNode("if1"), delay("d")],
        edges: [edge("if1", "d", "true")],
      };
      expect(validateGraph(g).join(" ")).toContain("at least one action it can reach");
    });
  });

  describe("timing", () => {
    it("rejects a non-positive or oversized delay", () => {
      const withDelay = (seconds: number): AutomationGraph => ({
        entry: "d",
        nodes: [delay("d", seconds), action("a")],
        edges: [edge("d", "a")],
      });
      expect(validateGraph(withDelay(0)).join(" ")).toContain("positive number of seconds");
      expect(validateGraph(withDelay(MAX_DELAY_SECONDS + 1)).join(" ")).toContain(`exceed ${MAX_DELAY_SECONDS}`);
      expect(validateGraph(withDelay(MAX_DELAY_SECONDS))).toEqual([]);
    });

    it("budgets delays per route, not across the whole graph", () => {
      // Two branches each waiting 200s is fine - no single visitor waits 400s.
      const half = MAX_DELAY_SECONDS - 100;
      const g: AutomationGraph = {
        entry: "if1",
        nodes: [ifNode("if1"), delay("d1", half), delay("d2", half), action("a"), action("b")],
        edges: [
          edge("if1", "d1", "true"),
          edge("if1", "d2", "false"),
          edge("d1", "a"),
          edge("d2", "b"),
        ],
      };
      expect(validateGraph(g)).toEqual([]);
    });

    it("rejects a single route that waits past the budget", () => {
      const g: AutomationGraph = {
        entry: "d1",
        nodes: [delay("d1", 200), delay("d2", 200), action("a")],
        edges: [edge("d1", "d2"), edge("d2", "a")],
      };
      expect(validateGraph(g).join(" ")).toContain("the limit is");
    });

    it("counts a wait's timeout against the same budget", () => {
      const g: AutomationGraph = {
        entry: "w",
        nodes: [waitNode("w", 200), delay("d", 200), action("a"), action("b")],
        edges: [edge("w", "d", "met"), edge("w", "b", "timeout"), edge("d", "a")],
      };
      expect(validateGraph(g).join(" ")).toContain("the limit is");
    });

    it("rejects a non-positive or oversized wait timeout", () => {
      const g: AutomationGraph = {
        entry: "w",
        nodes: [waitNode("w", 0), action("a"), action("b")],
        edges: [edge("w", "a", "met"), edge("w", "b", "timeout")],
      };
      expect(validateGraph(g)).toContain("A wait needs a positive timeout.");
    });
  });

  describe("webhooks and waits", () => {
    it("accepts a webhook before a wait", () => {
      const g: AutomationGraph = {
        entry: "h",
        nodes: [webhook("h"), waitNode("w"), action("a"), action("b")],
        edges: [edge("h", "w"), edge("w", "a", "met"), edge("w", "b", "timeout")],
      };
      expect(validateGraph(g)).toEqual([]);
    });

    it("rejects a webhook after a wait, explaining why", () => {
      // The server has already answered the tracker by the time the wait resolves, so a
      // webhook there would simply never be sent. Better refused than silently dropped.
      const g: AutomationGraph = {
        entry: "w",
        nodes: [waitNode("w"), webhook("h"), action("b")],
        edges: [edge("w", "h", "met"), edge("w", "b", "timeout")],
      };
      expect(validateGraph(g).join(" ")).toContain("cannot come after a wait");
    });

    it("rejects a webhook on the timeout branch too", () => {
      const g: AutomationGraph = {
        entry: "w",
        nodes: [waitNode("w"), action("a"), webhook("h")],
        edges: [edge("w", "a", "met"), edge("w", "h", "timeout")],
      };
      expect(validateGraph(g).join(" ")).toContain("cannot come after a wait");
    });

    it("allows a webhook on a branch that never passes through the wait", () => {
      const g: AutomationGraph = {
        entry: "if1",
        nodes: [ifNode("if1"), waitNode("w"), action("a"), action("b"), webhook("h")],
        edges: [
          edge("if1", "w", "true"),
          edge("if1", "h", "false"),
          edge("w", "a", "met"),
          edge("w", "b", "timeout"),
        ],
      };
      expect(validateGraph(g)).toEqual([]);
    });

    it("permits a client action after a wait", () => {
      const g: AutomationGraph = {
        entry: "w",
        nodes: [waitNode("w"), action("a"), action("b")],
        edges: [edge("w", "a", "met"), edge("w", "b", "timeout")],
      };
      expect(validateGraph(g)).toEqual([]);
    });
  });

  it("reports every problem at once rather than one per save", () => {
    const g: AutomationGraph = {
      entry: "if1",
      nodes: [ifNode("if1"), delay("d", -5), action("orphan")],
      edges: [edge("if1", "d", "true")],
    };
    const errors = validateGraph(g);
    expect(errors.length).toBeGreaterThan(2);
  });

  it("does not repeat the same message", () => {
    const g: AutomationGraph = {
      entry: "w",
      nodes: [waitNode("w"), webhook("h"), webhook("h2")],
      edges: [edge("w", "h", "met"), edge("w", "h2", "timeout")],
    };
    const errors = validateGraph(g);
    expect(new Set(errors).size).toBe(errors.length);
  });
});
