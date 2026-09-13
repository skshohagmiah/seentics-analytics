/**
 * Server-side automation evaluation.
 *
 * Called by POST /tracker/automations/evaluate (no auth — tracker origin validated upstream).
 *
 * Flow:
 *  1. Load active automations for the website (sorted by priority ASC)
 *  2. For each: match trigger type → evaluate conditions → check frequency caps → pick A/B variant
 *  3. Dispatch webhook actions async (fire-and-forget)
 *  4. Record impressions and enqueue `automation.triggered` in one transaction
 *  5. Return client-side action payloads
 */

import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { automationEvents, db, userProfiles } from '../../../db';
import { log } from '../../../platform/lib/logger';
import type {
  AutomationEvaluation,
  ClientAction,
  EvaluateRequest,
  EvaluateResult,
} from '../interfaces';
import { listActiveAutomationsByPriority } from '../repositories/postgres-automation.repository';
import { evaluateConditions } from '../lib/automation-condition-evaluator';
import {
  getImpressionStats,
  isCappedFromStats,
  recordImpressions,
  capsRequireLookup,
  type FrequencyCapSpec,
  type ImpressionMeta,
} from './automation-frequency-cap.service';
import { executeWebhook, type WebhookAction } from './automation-webhook-execution.service';
import { renderTemplateDeep } from '../lib/automation-template-renderer';
import type { AutomationGraph } from '../lib/automation-graph';
import { walkGraph, type Continuation } from './automation-graph-execution.service';

// The request/result contract now lives in `../interfaces` — it is the module's
// public surface, not an implementation detail. Re-exported because the tracker
// route and its tests already import these names from here.
export type { ClientAction, EvaluateRequest, EvaluateResult };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A stored automation definition.
 *
 * Two lists and two option bags: the triggers that can start it, and the steps that
 * make up its body. Conditions and actions are not separate fields — they are step
 * kinds, which is what lets them interleave.
 */
type AutomationDef = {
  triggers?: Array<{ type?: string; [k: string]: unknown }>;
  graph?: AutomationGraph;
  frequency?: FrequencyCapSpec;
  abTest?: {
    enabled?: boolean;
    variants?: Array<{ id: string; weight?: number; [k: string]: unknown }>;
  };
};

function castDef(raw: Record<string, unknown>): AutomationDef {
  return raw as AutomationDef;
}

/** An automation matches when ANY of its triggers has the incoming type. */
function triggerMatches(def: AutomationDef, incoming: EvaluateRequest['trigger']): boolean {
  const triggers = Array.isArray(def.triggers) ? def.triggers : [];
  return triggers.some((t) => !!t?.type && t.type === incoming.type);
}

/**
 * Render a continuation's actions, recursively.
 *
 * The browser cannot resolve `{{ user.name }}` — the facts live on the server — so every
 * branch is rendered up front against the same context the immediate actions used.
 */
function renderContinuation(c: Continuation, context: Record<string, unknown>): Continuation {
  return {
    ...c,
    met: c.met.map((a) => renderTemplateDeep(a, context) as typeof a),
    timeout: c.timeout.map((a) => renderTemplateDeep(a, context) as typeof a),
    ...(c.metContinuation ? { metContinuation: renderContinuation(c.metContinuation, context) } : {}),
    ...(c.timeoutContinuation
      ? { timeoutContinuation: renderContinuation(c.timeoutContinuation, context) }
      : {}),
  };
}

function pickVariant(abTest: AutomationDef['abTest']): string | null {
  if (!abTest?.enabled || !abTest.variants?.length) return null;
  const variants = abTest.variants;
  const totalWeight = variants.reduce((s, v) => s + (v.weight ?? 1), 0);
  let roll = Math.random() * totalWeight;
  for (const v of variants) {
    roll -= (v.weight ?? 1);
    if (roll <= 0) return v.id;
  }
  return variants[variants.length - 1]?.id ?? null;
}

async function loadUserProfile(websiteId: string, anonymousId: string): Promise<Record<string, unknown>> {
  try {
    const [row] = await db
      .select()
      .from(userProfiles)
      .where(and(eq(userProfiles.websiteId, websiteId), eq(userProfiles.anonymousId, anonymousId)))
      .limit(1);
    if (!row) return {};
    return {
      visitCount:     row.visitCount,
      totalPageViews: row.totalPageViews,
      country:        row.country,
      city:           row.city,
      device:         row.device,
      browser:        row.browser,
      firstSeenAt:    row.firstSeenAt?.toISOString(),
      lastSeenAt:     row.lastSeenAt?.toISOString(),
      ...(row.properties as Record<string, unknown>),
      ...(row.computed  as Record<string, unknown>),
    };
  } catch {
    return {};
  }
}

/** One row destined for `automation_events`, buffered until the batch write. */
type AutomationEventRow = typeof automationEvents.$inferInsert;

function serverRunRow(
  automationId: string,
  runId: string,
  anonymousId: string,
  sessionId: string,
  triggerType: string,
  pageUrl: string | undefined,
): AutomationEventRow {
  return {
    automationId,
    runId,
    recordType:   'server_run',
    triggerEvent: triggerType,
    status:       'running',
    visitorId:    anonymousId,
    sessionId,
    pageUrl:      pageUrl ?? null,
  };
}

function actionResultRow(
  automationId: string,
  runId: string,
  actionKey: string,
  status: 'success' | 'failed',
  durationMs: number,
  errorMessage?: string,
): AutomationEventRow {
  return {
    automationId,
    runId,
    recordType: 'action',
    actionKey,
    status,
    durationMs,
    errorMessage: errorMessage ?? null,
  };
}

/**
 * Write the run log for one evaluate, in one statement.
 *
 * These used to be individual `db.insert` calls, `void`ed at the call site: one per
 * matched automation for the run row, plus one per action it dispatched. An evaluate that
 * matched three automations with four actions each fired fifteen separate inserts, none of
 * them awaited — so nothing bounded how many were in flight, on a tracker-facing endpoint
 * any visitor can trigger. Being un-awaited was the worse half: the statements still queued
 * on the same 25-connection pool as the analytics writes, they just did it invisibly and
 * without backpressure.
 *
 * Still best-effort. The log is diagnostic; the impressions and their outbox events are the
 * record, and those have their own transaction.
 */
async function writeEventLog(rows: AutomationEventRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.insert(automationEvents).values(rows);
  } catch (err) {
    log.warn({ msg: 'auto_event_log_failed', rows: rows.length, err });
  }
}

// ─── Evaluation service ───────────────────────────────────────────────────────

/**
 * Decides which automations fire for a trigger, and fires them.
 *
 * Two different delivery guarantees are used here on purpose:
 *
 * - `automation.triggered` goes through the **transactional outbox**, enqueued in
 *   the same transaction as the impression it belongs to. An automation firing is
 *   externally visible — it can send a webhook — and it is also what frequency
 *   caps are charged against, so an announcement lost to a crash between COMMIT
 *   and publish would leave a visitor capped for something no consumer ever heard
 *   about. The cost is at-least-once delivery: a consumer must dedupe, and
 *   `runId` is on the payload to be the key it dedupes on.
 * - `automation.action_executed` goes straight to the **bus**. It is one row's
 *   worth of observability per action, already durably recorded in
 *   `automation_events` for the dashboard, and it fires often. Paying for a
 *   transactional write per action to guarantee delivery of a signal whose loss
 *   costs nothing would be the wrong trade.
 *
 * The bus arrives by constructor injection so nothing here knows whether it is
 * in-process or a broker.
 */
/**
 * The collaborators the evaluation path calls out to.
 *
 * Injectable so this service can be exercised without a database and without module
 * mocks. Reaching for them through imports made it untestable in isolation: the only
 * way to stub the webhook executor was `mock.module`, whose registry is process-global,
 * so this file's stubs silently became the executor's own tests' executor.
 *
 * Production passes nothing and gets {@link defaultEvaluationDependencies}.
 */
export type EvaluationDependencies = {
  listActiveAutomationsByPriority: typeof listActiveAutomationsByPriority;
  getImpressionStats: typeof getImpressionStats;
  executeWebhook: typeof executeWebhook;
};

const defaultEvaluationDependencies: EvaluationDependencies = {
  listActiveAutomationsByPriority,
  getImpressionStats,
  executeWebhook,
};

export class AutomationEvaluationService
  implements AutomationEvaluation
{
  private readonly deps: EvaluationDependencies;

  /** `deps` is a partial override; anything unnamed stays the real implementation. */
  constructor(
    deps: Partial<EvaluationDependencies> = {},
  ) {
    this.deps = { ...defaultEvaluationDependencies, ...deps };
  }

  async evaluate(req: EvaluateRequest): Promise<EvaluateResult> {
    const { websiteId, anonymousId, userId, sessionId, trigger, context } = req;

    // Load user profile facts to merge into condition context
    const profileFacts = await loadUserProfile(websiteId, anonymousId);
    const fullContext: Record<string, unknown> = {
      ...profileFacts,
      ...context,
      user: { ...(profileFacts as object), ...(context.user as object ?? {}) },
      session: { id: sessionId, ...(context.session as object ?? {}) },
      trigger,
    };

    // Load active automations sorted by priority
    const rows = await this.deps.listActiveAutomationsByPriority(websiteId);

    // First pass (no DB): narrow to automations whose trigger + conditions match.
    // Cache the parsed definition so we don't castDef twice per automation.
    const candidates: {
      auto: (typeof rows)[number];
      def: AutomationDef;
      caps: FrequencyCapSpec;
      walked: ReturnType<typeof walkGraph>;
    }[] = [];
    for (const auto of rows) {
      const def = castDef(auto.definition);
      if (!triggerMatches(def, trigger)) continue;

      // Walked before the cap lookup so an automation whose route reaches nothing can
      // be discarded without paying for its impression stats. Walking is pure and
      // cheap — no database, no clock — so doing it twice would be the greater cost.
      const walked = def.graph ? walkGraph(def.graph, fullContext) : null;
      if (!walked || (!walked.actions.length && !walked.webhooks.length && !walked.continuation)) {
        continue;
      }

      candidates.push({ auto, def, caps: def.frequency ?? {}, walked });
    }

    // One batched impression-stats query for every candidate that has a cap needing a
    // lookup — replaces up to 3 sequential COUNT queries PER automation.
    const cappedIds = candidates.filter((c) => capsRequireLookup(c.caps)).map((c) => c.auto.id);
    const stats = await this.deps.getImpressionStats(cappedIds, anonymousId, sessionId);

    const clientActions: ClientAction[] = [];
    const impressions: ImpressionMeta[] = [];
    /** Run and action rows for every automation matched here, written in one statement below. */
    const eventLog: AutomationEventRow[] = [];
    let matched = 0;

    for (const { auto, def, caps, walked } of candidates) {
      if (isCappedFromStats(stats.get(auto.id), caps)) continue;

      matched++;
      const runId   = randomUUID();
      const variant = pickVariant(def.abTest);

      // Buffered, not written: the whole run log for this evaluate goes out in one insert.
      eventLog.push(
        serverRunRow(auto.id, runId, anonymousId, sessionId, trigger.type, context.page as string | undefined),
      );

      // Buffer the impression; all matched impressions are inserted in one round trip below.
      impressions.push({ automationId: auto.id, anonymousId, userId, websiteId, sessionId, variant });

      // The route was decided by `walkGraph`; what remains is dispatching it. Actions
      // are keyed by their position in the *walked* order, so the run log reads as the
      // path the visitor actually took rather than as positions in the stored graph.
      let actionIndex = 0;

      for (const action of walked.webhooks) {
        const actionKey = `${action.type}_${actionIndex++}`;
        const t0 = Date.now();
        void this.deps.executeWebhook(auto.id, action as unknown as WebhookAction, fullContext, runId)
          .then(() => {
            const ms = Date.now() - t0;
            // Written on its own, unlike the rest: a webhook finishes at an arbitrary later
            // point, long after the batch below has gone out. One insert per webhook is
            // proportionate next to the outbound HTTP call it is recording.
            void writeEventLog([actionResultRow(auto.id, runId, actionKey, 'success', ms)]);
          })
          .catch((err: unknown) => {
            const ms = Date.now() - t0;
            log.warn({ msg: 'webhook_action_error', automationId: auto.id, err });
            void writeEventLog([actionResultRow(auto.id, runId, actionKey, 'failed', ms, String(err))]);
          });
      }

      for (const planned of walked.actions) {
        const { delayMs, ...action } = planned;
        const actionKey = `${action.type}_${actionIndex++}`;
        const rendered = renderTemplateDeep(action, fullContext) as Record<string, unknown>;

        clientActions.push({
          ...rendered,
          type:          String(action.type),
          automation_id: auto.id,
          variant,
          run_id:        runId,
          ...(delayMs > 0 ? { delay_ms: delayMs } : {}),
        });

        eventLog.push(actionResultRow(auto.id, runId, actionKey, 'success', 0));
      }

      // Work the page finishes after a wait. Rendered here rather than in the walker so
      // templates resolve against the same context every other action saw.
      if (walked.continuation) {
        clientActions.push({
          type:          'continue_when',
          automation_id: auto.id,
          variant,
          run_id:        runId,
          continuation:  renderContinuation(walked.continuation, fullContext),
        });
      }
    }

    // Two statements, run together: the impressions this evaluate charged against the
    // frequency caps, and the run log beside them. They are independent — the log is
    // diagnostic and must not fail the evaluate, the impressions are the record.
    if (impressions.length > 0) {
      await Promise.all([this.commitImpressions(impressions), writeEventLog(eventLog)]);
    }

    return { matched, actions: clientActions };
  }

  /**
   * Record every impression from this evaluate in one statement.
   *
   * No transaction: this is a single insert, and there is nothing left to commit alongside
   * it. It used to write `automation.triggered` rows to a transactional outbox in the same
   * transaction so the announcement could not disagree with the impression — but nothing
   * ever subscribed to that event, so the transaction, the outbox row, the once-a-second
   * poll that drained it and the bus it was delivered to all existed to inform nobody.
   */
  private async commitImpressions(impressions: ImpressionMeta[]): Promise<void> {
    await recordImpressions(impressions);
  }
}
