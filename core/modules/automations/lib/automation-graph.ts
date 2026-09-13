/**
 * An automation's body: a directed acyclic graph.
 *
 * Execution enters at `entry` and walks edges until it runs out. Every node has at most
 * one *taken* outgoing edge per run — a branch node picks one, everything else has a
 * single successor — so an execution is a single path through the graph, not a fan-out.
 * That is what makes convergence free: two branches can point at the same node, and
 * because only one of them is ever walked in a given run, the shared node runs once
 * without any visited-set bookkeeping.
 *
 * Cycles are rejected rather than bounded. A loop would need a durable scheduler and a
 * per-visitor iteration count to be safe, and neither exists; refusing them at save time
 * is honest, where a silent iteration cap would not be.
 *
 * ─── Node kinds ─────────────────────────────────────────────────────────────────
 *
 *  - `action`     one thing to do. Client actions are returned to the tracker; a
 *                 `webhook` is dispatched server-side.
 *  - `delay`      holds the *next client action* back by N seconds. It does not defer
 *                 server-side work — see the note on `wait_until` below.
 *  - `if`         two outgoing branches, `true` and `false`.
 *  - `switch`     one branch per case, evaluated in order, plus `default`.
 *  - `wait_until` holds until a condition becomes true or a timeout elapses, then takes
 *                 the `met` or `timeout` branch.
 *
 * ─── What a delay and a wait actually defer ─────────────────────────────────────
 *
 * Evaluation is synchronous with the tracker's request, so neither can defer work the
 * *server* does. Both compile into instructions the browser carries out: the client
 * actions after them are scheduled, and a `wait_until` re-evaluates its condition in the
 * page against a snapshot of the facts the server resolved.
 *
 * The consequence is a validation rule rather than a silent surprise: a `webhook` may
 * not appear downstream of a `wait_until`, because the server has already answered the
 * request by the time that branch is decided. {@link validateGraph} refuses it.
 */

import type { ConditionGroup } from "./automation-condition-evaluator";

export type NodeId = string;

export type AutomationAction = { type: string; [k: string]: unknown };

/** One case of a `switch`, matched in declaration order. */
export type SwitchCase = { id: string; label?: string; group: ConditionGroup };

export type GraphNode =
  | { id: NodeId; kind: "action"; action: AutomationAction }
  | { id: NodeId; kind: "delay"; seconds: number }
  | { id: NodeId; kind: "if"; group: ConditionGroup }
  | { id: NodeId; kind: "switch"; cases: SwitchCase[] }
  | { id: NodeId; kind: "wait_until"; group: ConditionGroup; timeoutSeconds: number };

/**
 * A connection between two nodes.
 *
 * `branch` names which outlet of `from` this edge leaves by. It is absent for nodes with
 * a single outlet, `"true"`/`"false"` for an `if`, a case id or `"default"` for a
 * `switch`, and `"met"`/`"timeout"` for a `wait_until`.
 */
export type GraphEdge = { from: NodeId; to: NodeId; branch?: string };

export type AutomationGraph = {
  entry: NodeId;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

/** Upper bound on a single delay or timeout, and on the total along any one path. */
export const MAX_DELAY_SECONDS = 300;

/** Guard rails on graph size. Generous for real automations, fatal for pathological ones. */
export const MAX_NODES = 100;
export const MAX_EDGES = 200;
export const MAX_SWITCH_CASES = 10;

/** The branch labels a node kind may leave by. `null` means "one unlabelled outlet". */
export function outletsFor(node: GraphNode): string[] | null {
  switch (node.kind) {
    case "if":
      return ["true", "false"];
    case "wait_until":
      return ["met", "timeout"];
    case "switch":
      return [...node.cases.map((c) => c.id), "default"];
    default:
      return null;
  }
}

/** Whether a node picks between several outlets rather than having a single successor. */
export function isBranchNode(node: GraphNode): boolean {
  return outletsFor(node) !== null;
}

/** Index the graph for traversal. Built once per walk rather than scanned per step. */
export function indexGraph(graph: AutomationGraph): {
  byId: Map<NodeId, GraphNode>;
  outgoing: Map<NodeId, GraphEdge[]>;
} {
  const byId = new Map<NodeId, GraphNode>();
  for (const node of graph.nodes) byId.set(node.id, node);

  const outgoing = new Map<NodeId, GraphEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }
  return { byId, outgoing };
}

/** The edge leaving `from` by `branch`, or undefined when that outlet is unconnected. */
export function edgeFor(
  outgoing: Map<NodeId, GraphEdge[]>,
  from: NodeId,
  branch?: string,
): GraphEdge | undefined {
  const edges = outgoing.get(from);
  if (!edges) return undefined;
  return branch === undefined
    ? edges.find((e) => e.branch === undefined)
    : edges.find((e) => e.branch === branch);
}

// ─── Structural queries ───────────────────────────────────────────────────────

/** Node ids reachable from `entry`, following every edge. */
export function reachableFrom(graph: AutomationGraph, entry: NodeId): Set<NodeId> {
  const { outgoing } = indexGraph(graph);
  const seen = new Set<NodeId>();
  const stack = [entry];

  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of outgoing.get(id) ?? []) stack.push(edge.to);
  }
  return seen;
}

/**
 * The first cycle found, as the node ids on it, or `null` when the graph is acyclic.
 *
 * Returns the offending path rather than a boolean so the builder can highlight it —
 * "this graph has a cycle" is not actionable when there are forty nodes.
 */
export function findCycle(graph: AutomationGraph): NodeId[] | null {
  const { outgoing } = indexGraph(graph);
  const state = new Map<NodeId, "visiting" | "done">();
  const path: NodeId[] = [];

  function visit(id: NodeId): NodeId[] | null {
    const seen = state.get(id);
    if (seen === "done") return null;
    if (seen === "visiting") return [...path.slice(path.indexOf(id)), id];

    state.set(id, "visiting");
    path.push(id);
    for (const edge of outgoing.get(id) ?? []) {
      const cycle = visit(edge.to);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return null;
  }

  for (const node of graph.nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Every path from `entry` to a leaf, as node-id lists.
 *
 * Only used by validation, where the questions are per-path ("does the delay budget hold
 * along this route?", "is there a webhook after a wait?"). Bounded by {@link MAX_NODES}
 * and the acyclicity check, both of which run first.
 */
export function pathsFrom(graph: AutomationGraph, entry: NodeId): NodeId[][] {
  const { outgoing } = indexGraph(graph);
  const paths: NodeId[][] = [];

  function walk(id: NodeId, sofar: NodeId[]): void {
    const next = outgoing.get(id) ?? [];
    if (next.length === 0) {
      paths.push([...sofar, id]);
      return;
    }
    for (const edge of next) walk(edge.to, [...sofar, id]);
  }

  walk(entry, []);
  return paths;
}
