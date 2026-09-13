/**
 * Frequency cap helpers — read / write automation_impressions.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db, automationImpressions } from '../../../db';

export interface ImpressionMeta {
  automationId: string;
  anonymousId: string;
  userId?: string | null;
  /** Website **UUID** — `automation_impressions.website_id` is a uuid column. */
  websiteId: string;
  sessionId: string;
  variant?: string | null;
}

/**
 * Batch-insert impressions in a single round trip.
 *
 * Takes a `writer` so the caller can join the insert to a transaction that also
 * enqueues the `automation.triggered` outbox rows — an impression the visitor was
 * charged for and an event announcing it must commit together, or a crash between
 * them leaves the automation capped with nothing having been announced. Defaults
 * to the shared handle for callers with no transaction to join.
 */
/** The shared `db` handle or a transaction handle — whichever the caller has. */
type InsertWriter = Pick<typeof db, 'insert'>;

export async function recordImpressions(
  metas: ImpressionMeta[],
  writer: InsertWriter = db,
): Promise<void> {
  if (metas.length === 0) return;
  await writer.insert(automationImpressions).values(
    metas.map((m) => ({
      automationId: m.automationId,
      anonymousId:  m.anonymousId,
      userId:       m.userId ?? null,
      websiteId:    m.websiteId,
      sessionId:    m.sessionId,
      variant:      m.variant ?? null,
    })),
  );
}

export interface FrequencyCapSpec {
  maxPerSession?: number;
  maxPerUser?: number;
  cooldownDays?: number;
}

export interface ImpressionStats {
  /** Impressions for this automation in the current session. */
  sessionCount: number;
  /** Lifetime impressions for this automation for the anonymous visitor. */
  lifetimeCount: number;
  /** Most recent impression time for the anonymous visitor (for cooldowns). */
  lastShownAt: Date | null;
}

/** Whether any cap on the spec requires a DB lookup at all. */
export function capsRequireLookup(caps: FrequencyCapSpec): boolean {
  return caps.maxPerSession != null || caps.maxPerUser != null || caps.cooldownDays != null;
}

/**
 * Batched impression stats for many automations in ONE query.
 * Returns per-automation session count, lifetime count and last-shown time.
 * Only rows matching this visitor (anonymousId) or session (sessionId) are scanned.
 */
/**
 * Session and lifetime impression counts for a set of automations, in one query.
 *
 * Replaces up to three sequential `COUNT`s per automation, which is why the caller batches
 * every capped candidate into a single call.
 *
 * The `OR` below needs **both** sides indexed to stay cheap: `ix_auto_imp_auto_anon` for
 * the visitor and `ix_auto_imp_auto_session` for the session. With only the first, Postgres
 * indexes `automation_id` alone and filters the rest, reading every impression the
 * automation has ever accumulated — 90,000 index entries where 10 were wanted, on 300k
 * rows, and worse every day the table grows. See the migration for the measurement.
 */
export async function getImpressionStats(
  automationIds: string[],
  anonymousId: string,
  sessionId: string,
): Promise<Map<string, ImpressionStats>> {
  const map = new Map<string, ImpressionStats>();
  if (automationIds.length === 0) return map;

  const rows = await db
    .select({
      automationId:  automationImpressions.automationId,
      sessionCount:  sql<number>`count(*) filter (where ${automationImpressions.sessionId} = ${sessionId})::int`,
      lifetimeCount: sql<number>`count(*) filter (where ${automationImpressions.anonymousId} = ${anonymousId})::int`,
      lastShownAt:   sql<Date | null>`max(${automationImpressions.shownAt}) filter (where ${automationImpressions.anonymousId} = ${anonymousId})`,
    })
    .from(automationImpressions)
    .where(and(
      inArray(automationImpressions.automationId, automationIds),
      or(
        eq(automationImpressions.anonymousId, anonymousId),
        eq(automationImpressions.sessionId, sessionId),
      ),
    ))
    .groupBy(automationImpressions.automationId);

  for (const r of rows) {
    map.set(r.automationId, {
      sessionCount:  Number(r.sessionCount  ?? 0),
      lifetimeCount: Number(r.lifetimeCount ?? 0),
      lastShownAt:   r.lastShownAt ? new Date(r.lastShownAt) : null,
    });
  }
  return map;
}

/** In-memory cap evaluation from pre-fetched stats. */
export function isCappedFromStats(stats: ImpressionStats | undefined, caps: FrequencyCapSpec): boolean {
  const sessionCount  = stats?.sessionCount  ?? 0;
  const lifetimeCount = stats?.lifetimeCount ?? 0;
  const lastShownAt   = stats?.lastShownAt   ?? null;

  if (caps.maxPerSession != null && sessionCount  >= caps.maxPerSession) return true;
  if (caps.maxPerUser    != null && lifetimeCount >= caps.maxPerUser)    return true;
  if (caps.cooldownDays  != null && lastShownAt) {
    const since = Date.now() - caps.cooldownDays * 86_400_000;
    if (lastShownAt.getTime() >= since) return true;
  }
  return false;
}
