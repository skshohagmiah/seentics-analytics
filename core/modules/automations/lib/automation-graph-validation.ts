/**
 * What makes a graph runnable.
 *
 * Returned as a list of messages rather than thrown, so the builder can show everything
 * wrong at once instead of surfacing one problem per save. Each message names the node
 * it concerns, because "this graph is invalid" is not actionable at forty nodes.
 *
 * The checks run in dependency order and bail where continuing would be meaningless:
 * there is no point looking for cycles in a graph whose edges point at nodes that do not
 * exist, and no point walking paths in one that has a cycle.
 */

import {
  MAX_DELAY_SECONDS,
  MAX_EDGES,
  MAX_NODES,
  MAX_SWITCH_CASES,
  edgeFor,
  findCycle,
  indexGraph,
  outletsFor,
  pathsFrom,
  reachableFrom,
  type AutomationGraph,
  type GraphNode,
  type NodeId,
} from "./automation-graph";

/** A short, stable way to refer to a node in a message. */
function label(node: GraphNode | undefined, id: NodeId): string {
  if (!node) return `"${id}"`;
  if (node.kind === "action") return `the ${node.action.type} action`;
  if (node.kind === "if") return "the if/else";
  if (node.kind === "switch") return "the switch";
  if (node.kind === "delay") return "the delay";
  return "the wait";
}

export function validateGraph(graph: AutomationGraph): string[] {
  const errors: string[] = [];

  // ── Shape ────────────────────────────────────────────────────────────────
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return ["The automation graph is malformed."];
  }
  if (graph.nodes.length === 0) return ["Add at least one action."];
  if (graph.nodes.length > MAX_NODES) errors.push(`An automation cannot exceed ${MAX_NODES} nodes.`);
  if (graph.edges.length > MAX_EDGES) errors.push(`An automation cannot exceed ${MAX_EDGES} connections.`);

  const seenIds = new Set<NodeId>();
  for (const node of graph.nodes) {
    if (seenIds.has(node.id)) errors.push(`Two nodes share the id "${node.id}".`);
    seenIds.add(node.id);
  }

  const { byId, outgoing } = indexGraph(graph);

  if (!byId.has(graph.entry)) {
    errors.push("The automation has no starting node.");
    return errors;
  }

  // ── Edges point somewhere real ───────────────────────────────────────────
  let danglingEdge = false;
  for (const edge of graph.edges) {
    if (!byId.has(edge.from)) {
      errors.push(`A connection starts from a node that does not exist ("${edge.from}").`);
      danglingEdge = true;
    }
    if (!byId.has(edge.to)) {
      errors.push(`A connection points at a node that does not exist ("${edge.to}").`);
      danglingEdge = true;
    }
  }
  // Every check below walks edges, so a dangling one would produce noise on top of the
  // real problem rather than more information.
  if (danglingEdge) return errors;

  // ── Outlets ──────────────────────────────────────────────────────────────
  for (const node of graph.nodes) {
    const outlets = outletsFor(node);
    const edges = outgoing.get(node.id) ?? [];

    if (outlets === null) {
      // A single successor. Two would make the run ambiguous.
      if (edges.length > 1) {
        errors.push(`${label(node, node.id)} has more than one outgoing connection.`);
      }
      if (edges.some((e) => e.branch !== undefined)) {
        errors.push(`${label(node, node.id)} has a labelled connection but no branches.`);
      }
      continue;
    }

    for (const edge of edges) {
      if (edge.branch === undefined) {
        errors.push(`${label(node, node.id)} has an unlabelled connection; every branch must be named.`);
      } else if (!outlets.includes(edge.branch)) {
        errors.push(`${label(node, node.id)} has no "${edge.branch}" branch.`);
      }
    }

    const used = new Set<string>();
    for (const edge of edges) {
      if (edge.branch === undefined) continue;
      if (used.has(edge.branch)) {
        errors.push(`${label(node, node.id)} has two connections on its "${edge.branch}" branch.`);
      }
      used.add(edge.branch);
    }

  }

  // ── Each node's own configuration ────────────────────────────────────────
  // A separate pass from the outlet checks above, which `continue` past nodes with a
  // single outlet — that skipped every delay, whose bounds then went unvalidated.
  for (const node of graph.nodes) {
    if (node.kind === "switch") {
      if (node.cases.length === 0) errors.push("A switch needs at least one case.");
      if (node.cases.length > MAX_SWITCH_CASES) {
        errors.push(`A switch cannot have more than ${MAX_SWITCH_CASES} cases.`);
      }
      const caseIds = new Set<string>();
      for (const c of node.cases) {
        if (caseIds.has(c.id)) errors.push(`The switch has two cases with the id "${c.id}".`);
        caseIds.add(c.id);
      }
    }

    if (node.kind === "wait_until") {
      if (!Number.isFinite(node.timeoutSeconds) || node.timeoutSeconds <= 0) {
        errors.push("A wait needs a positive timeout.");
      } else if (node.timeoutSeconds > MAX_DELAY_SECONDS) {
        errors.push(`A wait cannot exceed ${MAX_DELAY_SECONDS} seconds.`);
      }
    }

    if (node.kind === "delay") {
      if (!Number.isFinite(node.seconds) || node.seconds <= 0) {
        errors.push("A delay must be a positive number of seconds.");
      } else if (node.seconds > MAX_DELAY_SECONDS) {
        errors.push(`A delay cannot exceed ${MAX_DELAY_SECONDS} seconds.`);
      }
    }
  }

  // ── Acyclicity ───────────────────────────────────────────────────────────
  const cycle = findCycle(graph);
  if (cycle) {
    errors.push(`The connections form a loop (${cycle.join(" → ")}). Automations must flow forwards.`);
    // Path-walking below does not terminate on a cyclic graph.
    return errors;
  }

  // ── Reachability ─────────────────────────────────────────────────────────
  const reachable = reachableFrom(graph, graph.entry);
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      errors.push(`${label(node, node.id)} is not connected to anything and will never run.`);
    }
  }

  if (!graph.nodes.some((n) => n.kind === "action" && reachable.has(n.id))) {
    errors.push("An automation needs at least one action it can reach.");
  }

  // ── Per-path rules ───────────────────────────────────────────────────────
  for (const path of pathsFrom(graph, graph.entry)) {
    let budget = 0;
    let waited = false;

    for (const id of path) {
      const node = byId.get(id);
      if (!node) continue;

      if (node.kind === "delay") budget += node.seconds;
      if (node.kind === "wait_until") {
        budget += node.timeoutSeconds;
        waited = true;
      }

      // The server has already answered the tracker's request by the time a wait
      // resolves, so anything downstream of one runs in the browser. A webhook there
      // would simply never be sent.
      if (waited && node.kind === "action" && node.action.type === "webhook") {
        errors.push(
          "A webhook cannot come after a wait — the server has already responded by then. Move it before the wait.",
        );
      }
    }

    if (budget > MAX_DELAY_SECONDS) {
      errors.push(`One route waits ${budget}s in total; the limit is ${MAX_DELAY_SECONDS}s.`);
    }
  }

  // ── Unconnected branches ─────────────────────────────────────────────────
  // A warning-shaped error rather than a silent dead end: an `if` whose false branch
  // goes nowhere is usually an unfinished edit, and it is invisible on a busy canvas.
  for (const node of graph.nodes) {
    const outlets = outletsFor(node);
    if (!outlets || !reachable.has(node.id)) continue;
    for (const outlet of outlets) {
      if (!edgeFor(outgoing, node.id, outlet)) {
        errors.push(`${label(node, node.id)} has nothing connected to its "${outlet}" branch.`);
      }
    }
  }

  return [...new Set(errors)];
}
