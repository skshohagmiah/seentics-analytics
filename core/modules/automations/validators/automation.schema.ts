/**
 * Request validation for the automations HTTP surface.
 *
 * The definition is validated in full rather than passed through. It is an executable
 * document — it names webhook URLs the server will call and conditions that decide who
 * sees what — so "we will find out at evaluate time" is not an acceptable answer to a
 * malformed one. A rejected save is a builder bug the user can see; a definition that
 * saves and then silently never fires is one they cannot.
 */

import { z } from "zod";
import { zNonEmptyString } from "../../../platform/validation";
import { validateWebhookUrl } from "../../../platform/lib/origin";
import { OPERATORS } from "../lib/automation-condition-evaluator";
import {
  MAX_DELAY_SECONDS,
  MAX_EDGES,
  MAX_NODES,
  MAX_SWITCH_CASES,
  type AutomationGraph,
} from "../lib/automation-graph";
import { validateGraph } from "../lib/automation-graph-validation";

/** Trigger types the tracker can emit. Mirrors the builder's palette. */
export const TRIGGER_TYPES = [
  "page_view", "click", "scroll_depth", "time_on_page", "exit_intent",
  "inactivity", "rage_click", "form_abandon", "js_error", "tab_hidden",
  "tab_visible", "custom_event", "identify",
] as const;

/** Action types the tracker knows how to perform, plus the one the server performs. */
export const CLIENT_ACTION_TYPES = [
  "show_modal", "show_toast", "show_banner", "highlight_element", "show_tooltip",
  "personalize_content", "redirect", "tag_session",
] as const;

const ALLOWED_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Headers a definition must not set.
 *
 * `authorization` and `cookie` would let an automation borrow the server's identity;
 * the rest are hop-by-hop or computed, and overriding them corrupts the request.
 */
const FORBIDDEN_HEADER_NAMES = new Set([
  "host", "authorization", "cookie", "set-cookie", "content-length", "transfer-encoding",
]);

// ─── Conditions ───────────────────────────────────────────────────────────────

const ruleSchema = z.object({
  fact: zNonEmptyString.max(200),
  operator: z.enum(OPERATORS as unknown as [string, ...string[]]),
  value: z.unknown().optional(),
});

/**
 * A condition group, to any depth.
 *
 * Recursive, so the schema has to be declared lazily and annotated explicitly — Zod
 * cannot infer a type that refers to itself. Depth is bounded so a hand-crafted
 * definition cannot blow the evaluator's stack on the tracker edge.
 */
const MAX_GROUP_DEPTH = 5;

type ConditionGroupInput = {
  operator: "AND" | "OR" | "NOT";
  rules: Array<z.infer<typeof ruleSchema> | ConditionGroupInput>;
};

const conditionGroupSchema: z.ZodType<ConditionGroupInput> = z.lazy(() =>
  z.object({
    operator: z.enum(["AND", "OR", "NOT"]),
    rules: z.array(z.union([ruleSchema, conditionGroupSchema])).max(50),
  }),
);

function groupDepth(group: ConditionGroupInput, depth = 1): number {
  let deepest = depth;
  for (const rule of group.rules) {
    if ("rules" in rule) deepest = Math.max(deepest, groupDepth(rule, depth + 1));
  }
  return deepest;
}

const boundedConditionGroupSchema = conditionGroupSchema.refine(
  (g) => groupDepth(g) <= MAX_GROUP_DEPTH,
  { message: `Condition groups cannot nest more than ${MAX_GROUP_DEPTH} levels deep` },
);

// ─── Actions ──────────────────────────────────────────────────────────────────

const webhookActionSchema = z.object({
  type: z.literal("webhook"),
  url: z.string().refine(validateWebhookUrl, {
    message: "Invalid or disallowed webhook URL (must be https, non-internal)",
  }),
  method: z.enum(ALLOWED_HTTP_METHODS).optional().default("POST"),
  headers: z
    .record(z.string().max(4096))
    .optional()
    .refine((h) => !h || Object.keys(h).every((k) => !FORBIDDEN_HEADER_NAMES.has(k.toLowerCase())), {
      message: "One or more header names are not allowed",
    }),
  body: z.unknown().optional(),
});

/**
 * A client-side action.
 *
 * Passthrough on purpose, and only here: each action type carries its own configuration
 * fields, the builder evolves them faster than this file, and getting one wrong costs a
 * mis-rendered banner rather than an outbound request. The `type` itself is still closed.
 */
const clientActionSchema = z
  .object({ type: z.enum(CLIENT_ACTION_TYPES) })
  .passthrough();

const actionSchema = z.union([webhookActionSchema, clientActionSchema]);

// ─── Graph ────────────────────────────────────────────────────────────────────

const nodeIdSchema = zNonEmptyString.max(64);

const graphNodeSchema = z.discriminatedUnion("kind", [
  z.object({ id: nodeIdSchema, kind: z.literal("action"), action: actionSchema }),
  z.object({
    id: nodeIdSchema,
    kind: z.literal("delay"),
    seconds: z.number().positive().max(MAX_DELAY_SECONDS),
  }),
  z.object({ id: nodeIdSchema, kind: z.literal("if"), group: boundedConditionGroupSchema }),
  z.object({
    id: nodeIdSchema,
    kind: z.literal("switch"),
    cases: z
      .array(
        z.object({
          id: zNonEmptyString.max(64),
          label: z.string().max(80).optional(),
          group: boundedConditionGroupSchema,
        }),
      )
      .min(1)
      .max(MAX_SWITCH_CASES),
  }),
  z.object({
    id: nodeIdSchema,
    kind: z.literal("wait_until"),
    group: boundedConditionGroupSchema,
    timeoutSeconds: z.number().positive().max(MAX_DELAY_SECONDS),
  }),
]);

const graphEdgeSchema = z.object({
  from: nodeIdSchema,
  to: nodeIdSchema,
  branch: z.string().max(64).optional(),
});

/**
 * The graph, checked structurally here and semantically by {@link validateGraph}.
 *
 * The split is deliberate. Zod answers "is each node the right shape?", which it can do
 * per-node. Everything that makes a *graph* runnable — acyclicity, reachability, branch
 * wiring, per-route delay budgets, a webhook stranded behind a wait — is a property of
 * the whole thing, and lives in one place that the builder calls too. Duplicating those
 * rules in Zod would guarantee the two drift.
 */
const graphSchema = z
  .object({
    entry: nodeIdSchema,
    nodes: z.array(graphNodeSchema).min(1).max(MAX_NODES),
    edges: z.array(graphEdgeSchema).max(MAX_EDGES),
  })
  .superRefine((graph, ctx) => {
    for (const message of validateGraph(graph as unknown as AutomationGraph)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["graph"], message });
    }
  });

const triggerSchema = z
  .object({ type: z.enum(TRIGGER_TYPES) })
  .passthrough();

/**
 * The definition, validated as a whole.
 *
 * The cross-step rules live in a `superRefine` rather than in the step schema because
 * they are properties of the *chain*: a delay is only meaningless as the last step, and
 * the total delay budget is a sum. Each is reported against the step it concerns so the
 * builder can highlight the offending node.
 */
export const automationDefinitionSchema = z
  .object({
    triggers: z.array(triggerSchema).min(1).max(10),
    graph: graphSchema,
    frequency: z
      .object({
        maxPerSession: z.number().int().nonnegative().max(1000).optional(),
        maxPerUser: z.number().int().nonnegative().max(10_000).optional(),
        cooldownDays: z.number().int().nonnegative().max(365).optional(),
      })
      .optional(),
    abTest: z
      .object({
        enabled: z.boolean(),
        variants: z
          .array(z.object({ id: zNonEmptyString.max(64), weight: z.number().nonnegative().optional() }))
          .max(10),
      })
      .optional(),
    priority: z.number().int().optional(),
  })
  .superRefine((def, ctx) => {
    // An A/B test with no variants can never pick one, so every run would be unassigned.
    if (!def.abTest?.enabled) return;

    if (def.abTest.variants.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["abTest", "variants"],
        message: "An enabled A/B test needs at least one variant.",
      });
    }
    const ids = def.abTest.variants.map((v) => v.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["abTest", "variants"],
        message: "Variant ids must be unique.",
      });
    }
  });

export const automationsUpsertBodySchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  definition: automationDefinitionSchema,
});

/** A partial update: any field may be omitted, but a supplied one is validated in full. */
export const automationsPatchBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  definition: automationDefinitionSchema.optional(),
});

export const automationsBulkDeleteSchema = z.object({
  ids: z.array(zNonEmptyString.max(128)).max(500).optional().default([]),
});
