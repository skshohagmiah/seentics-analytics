/**
 * Walking an automation graph for one visitor.
 *
 * Separated from the evaluation service because it is pure: given a graph, a condition
 * context, and a way to dispatch a webhook, it decides what happens. No database, no
 * clock beyond the delays it accumulates, no impressions. That makes the branching
 * logic — which is where the subtlety is — testable without standing up a request.
 *
 * ─── One run is one path ────────────────────────────────────────────────────────
 *
 * At every node exactly one outgoing edge is taken: a branch node picks, everything else
 * has a single successor. So a run traces a path, never a tree, and a node two branches
 * converge on executes once because only one branch was walked. No visited set is needed
 * — the graph is validated acyclic, so a path cannot revisit a node either.
 *
 * ─── What the browser finishes ──────────────────────────────────────────────────
 *
 * `delay` and `wait_until` cannot pause the server: evaluation is synchronous with the
 * tracker's request. Both compile into instructions the page carries out. A `delay`
 * becomes `delay_ms` on the actions after it. A `wait_until` becomes a *continuation* —
 * the condition, its timeout, and the two branches already flattened into action lists —
 * which the tracker resolves locally. The server therefore stops walking at a wait and
 * hands the rest over, which is exactly why a webhook may not appear downstream of one.
 */

import {
  edgeFor,
  indexGraph,
  MAX_NODES,
  type AutomationAction,
  type AutomationGraph,
  type GraphNode,
  type NodeId,
} from "../lib/automation-graph";
import { evaluateConditions } from "../lib/automation-condition-evaluator";

/** One client-side action, with the offset the browser should hold it back by. */
export type PlannedAction = AutomationAction & { delayMs: number };

/**
 * Work the browser finishes after a `wait_until`.
 *
 * Both outcomes are precomputed: the server cannot know which will happen, and asking
 * the tracker a second time would cost a round trip per wait.
 */
export type Continuation = {
  /** Condition the page re-evaluates, against `facts` merged with what it observes. */
  group: unknown;
  /**
   * The server-resolved facts, snapshotted.
   *
   * The page can see what the visitor does next — scrolled, clicked, navigated — but not
   * the profile facts a condition may also name (visit count, country, plan). Sending
   * them along is what lets one condition language work on both sides. It is a snapshot,
   * which is honest for a window measured in seconds.
   */
  facts: Record<string, unknown>;
  timeoutMs: number;
  /** Offset at which the wait itself begins. */
  startMs: number;
  met: PlannedAction[];
  timeout: PlannedAction[];
  /** Nested waits, one per branch, when a branch contains another wait. */
  metContinuation?: Continuation;
  timeoutContinuation?: Continuation;
};

export type WalkResult = {
  /** Client actions the server resolved directly, in execution order. */
  actions: PlannedAction[];
  /** Webhook actions to dispatch, in execution order. */
  webhooks: AutomationAction[];
  /** Set when the path reached a wait; the browser finishes from here. */
  continuation?: Continuation;
};

/** Whether an action is dispatched by the server rather than returned to the tracker. */
function isServerAction(action: AutomationAction): boolean {
  return action.type === "webhook";
}

/**
 * Which outlet a branch node takes.
 *
 * `wait_until` is absent because the server never resolves one — reaching it ends the
 * server's walk and produces a continuation instead.
 */
function chooseBranch(node: GraphNode, context: Record<string, unknown>): string | undefined {
  if (node.kind === "if") {
    return evaluateConditions(node.group, context) ? "true" : "false";
  }
  if (node.kind === "switch") {
    // Cases are matched in declaration order, so an earlier case shadows a later one
    // that would also have matched. That is what makes a switch readable top-to-bottom.
    const hit = node.cases.find((c) => evaluateConditions(c.group, context));
    return hit ? hit.id : "default";
  }
  return undefined;
}

/**
 * Walk from `start` until the graph runs out or a wait hands over to the browser.
 *
 * `budgetMs` is the offset already accumulated before this segment, so a continuation's
 * branches carry the delays that preceded their wait.
 */
function walkFrom(
  graph: AutomationGraph,
  start: NodeId | undefined,
  context: Record<string, unknown>,
  budgetMs: number,
): WalkResult {
  const actions: PlannedAction[] = [];
  const webhooks: AutomationAction[] = [];
  const { byId, outgoing } = indexGraph(graph);

  let current = start;
  let delayMs = budgetMs;
  // The graph is validated acyclic before it is ever stored, so this bound is a
  // backstop against a hand-edited definition rather than the normal exit.
  let steps = 0;

  while (current && steps++ <= MAX_NODES) {
    const node = byId.get(current);
    if (!node) break;

    if (node.kind === "delay") {
      delayMs += Math.max(0, node.seconds) * 1000;
      current = edgeFor(outgoing, node.id)?.to;
      continue;
    }

    if (node.kind === "action") {
      if (isServerAction(node.action)) webhooks.push(node.action);
      else actions.push({ ...node.action, delayMs });
      current = edgeFor(outgoing, node.id)?.to;
      continue;
    }

    if (node.kind === "wait_until") {
      // The server stops here. Both outcomes are walked ahead of time so the page can
      // finish without another round trip.
      const met = walkFrom(graph, edgeFor(outgoing, node.id, "met")?.to, context, 0);
      const timeout = walkFrom(graph, edgeFor(outgoing, node.id, "timeout")?.to, context, 0);

      return {
        actions,
        // A webhook downstream of a wait is refused at save time, so anything the
        // branches collected here would be unreachable; dropping it keeps the
        // contract honest rather than silently sending it early.
        webhooks,
        continuation: {
          group: node.group,
          facts: context,
          timeoutMs: Math.max(0, node.timeoutSeconds) * 1000,
          startMs: delayMs,
          met: met.actions,
          timeout: timeout.actions,
          ...(met.continuation ? { metContinuation: met.continuation } : {}),
          ...(timeout.continuation ? { timeoutContinuation: timeout.continuation } : {}),
        },
      };
    }

    // if / switch
    const branch = chooseBranch(node, context);
    current = branch === undefined ? undefined : edgeFor(outgoing, node.id, branch)?.to;
  }

  return { actions, webhooks };
}

/** Whether a value is shaped like a graph at all. */
function isGraph(g: unknown): g is AutomationGraph {
  return (
    typeof g === "object" &&
    g !== null &&
    Array.isArray((g as AutomationGraph).nodes) &&
    Array.isArray((g as AutomationGraph).edges)
  );
}

/**
 * Walk a graph for one visitor. See the module note for what the browser finishes.
 *
 * Guards its own input because this runs on the unauthenticated tracker edge against a
 * document the schema validates on the way *in* — a definition written straight to the
 * database, or one stored before a shape change, must degrade to "this automation does
 * nothing" rather than take the endpoint down for every site on the process.
 */
export function walkGraph(
  graph: AutomationGraph,
  context: Record<string, unknown>,
): WalkResult {
  if (!isGraph(graph)) return { actions: [], webhooks: [] };
  return walkFrom(graph, graph.entry, context, 0);
}
