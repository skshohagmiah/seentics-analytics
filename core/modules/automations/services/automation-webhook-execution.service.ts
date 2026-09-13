/**
 * Async webhook executor with exponential back-off retry and delivery logging.
 */

import { db, webhookDeliveries } from '../../../db';
import { log } from '../../../platform/lib/logger';
import { validateWebhookUrl } from '../../../platform/lib/origin';
import { renderTemplateDeep } from '../lib/automation-template-renderer';

export interface WebhookAction {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * How hard to try before giving up on a delivery.
 *
 * A parameter rather than a module constant so the retry behaviour is reachable from a
 * test without waiting out seven real seconds of back-off. Production passes nothing
 * and gets {@link DEFAULT_WEBHOOK_RETRY}.
 */
export type WebhookRetryPolicy = { maxAttempts: number; baseDelayMs: number };

export const DEFAULT_WEBHOOK_RETRY: WebhookRetryPolicy = { maxAttempts: 4, baseDelayMs: 1_000 };

async function sleep(ms: number) {
  if (ms <= 0) return;
  return new Promise((r) => setTimeout(r, ms));
}

export async function executeWebhook(
  automationId: string,
  action: WebhookAction,
  context: Record<string, unknown>,
  runId?: string,
  policy: WebhookRetryPolicy = DEFAULT_WEBHOOK_RETRY,
): Promise<void> {
  const { maxAttempts, baseDelayMs } = policy;
  const url     = String(action.url ?? '');
  const method  = (action.method ?? 'POST').toUpperCase();
  const headers = (action.headers ?? {}) as Record<string, string>;
  const rawBody = action.body ?? {};

  if (!validateWebhookUrl(url)) {
    log.warn({ msg: 'webhook_blocked_ssrf', automationId, url });
    try {
      await db.insert(webhookDeliveries).values({
        automationId,
        runId: runId ?? null,
        url,
        statusCode: null,
        success: false,
        attemptCount: 0,
        lastAttemptAt: new Date(),
        responseMs: 0,
        error: 'URL blocked: failed SSRF validation',
      });
    } catch { /* best-effort log */ }
    return;
  }

  const renderedBody = renderTemplateDeep(rawBody, context);
  const payload = JSON.stringify({ ...renderedBody as object, _automation_id: automationId, _ts: Date.now() });

  let lastCode: number | null = null;
  let lastError: string | null = null;
  let success = false;
  let responseMs = 0;
  /** Attempts actually made — not the ceiling. See the delivery-log write below. */
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsMade = attempt;
    const start = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      responseMs  = Date.now() - start;
      lastCode    = res.status;
      success     = res.ok;
      lastError   = res.ok ? null : `HTTP ${res.status}`;
      if (res.ok) break;
    } catch (err) {
      responseMs = Date.now() - start;
      lastError  = err instanceof Error ? err.message : String(err);
      lastCode   = null;
    }

    if (attempt < maxAttempts) {
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  try {
    await db.insert(webhookDeliveries).values({
      automationId,
      runId: runId ?? null,
      url,
      statusCode: lastCode,
      success,
      // The count actually made. This used to be hard-coded to the ceiling, so every
      // delivery — including one that succeeded first time — was logged as four
      // attempts, which made the retry column useless for spotting a flaky endpoint.
      attemptCount: attemptsMade,
      lastAttemptAt: new Date(),
      responseMs,
      error: lastError,
    });
  } catch (err) {
    log.warn({ msg: 'webhook_delivery_log_failed', automationId, err });
  }

  if (!success) {
    log.warn({ msg: 'webhook_failed', automationId, url, lastCode, lastError });
  }
}
