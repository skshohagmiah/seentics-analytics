import { sql as pgSql, sessionReplays } from "../../../db";
import { sql as dsql } from "drizzle-orm";
import type { BatchTx } from "../../../platform/idempotency";
import type {
  SessionListFilters,
  SessionListSummary,
  SessionMetaRow,
} from "../interfaces";


export type SessionUpsertRow = {
  websiteId: string;
  sessionId: string;
  tsMs: number;
  latestEventMs: number;
  browser: string;
  device: string;
  os: string;
  country: string;
  entryPage: string;
  /** URL changes within this (sorted) batch — pages = transitions + entry page. */
  urlTransitions: number;
  /** First/last normalized page URL of the batch, for cross-batch boundary detection. */
  firstUrl: string;
  lastUrl: string;
  durationSeconds: number;
  hasRageClicks: boolean;
  hasErrors: boolean;
};

/**
 * Merge two upsert rows for the SAME session. Needed because Postgres rejects an
 * INSERT ... ON CONFLICT that touches the same row twice ("cannot affect row a
 * second time") — one duplicate would discard the whole batch.
 */
function mergeSessionRows(a: SessionUpsertRow, b: SessionUpsertRow): SessionUpsertRow {
  const [x, y] = a.tsMs <= b.tsMs ? [a, b] : [b, a];
  const boundary = x.lastUrl && y.firstUrl && x.lastUrl !== y.firstUrl ? 1 : 0;
  const pick = (p: string, q: string) => (p && p !== "Unknown" ? p : q);
  return {
    websiteId: x.websiteId,
    sessionId: x.sessionId,
    tsMs: x.tsMs,
    latestEventMs: Math.max(x.latestEventMs, y.latestEventMs),
    browser: pick(x.browser, y.browser),
    device: pick(x.device, y.device),
    os: pick(x.os, y.os),
    country: x.country || y.country,
    entryPage: x.entryPage || y.entryPage,
    urlTransitions: x.urlTransitions + y.urlTransitions + boundary,
    firstUrl: x.firstUrl || y.firstUrl,
    lastUrl: y.lastUrl || x.lastUrl,
    durationSeconds: Math.max(x.durationSeconds, y.durationSeconds),
    hasRageClicks: x.hasRageClicks || y.hasRageClicks,
    hasErrors: x.hasErrors || y.hasErrors,
  };
}

/**
 * Largest epoch-ms this module will persist.
 *
 * `_snc_re_end` is cast to `bigint` in the conflict clause below, so a value that is
 * fractional or wider than a bigint aborts the whole statement — taking every other
 * session in the same batch with it. The engine already truncates and clamps, and this
 * is the second line of defence at the point where the cast actually happens.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

function safeEpochMs(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const n = Math.trunc(v);
  if (n < 0) return 0;
  return n > MAX_EPOCH_MS ? MAX_EPOCH_MS : n;
}

/**
 * Mirrors Go UpsertSessionMetaBatch (sequence=0 metadata row). Batch insert/upsert in one query.
 *
 * Runs on the caller's transaction so it can share `applyBatchOnce`'s marker: `pages_viewed`
 * accumulates rather than being overwritten, so a redelivered batch would inflate it. The
 * marker and this write have to commit together for that guard to mean anything.
 *
 * `batchId` is also stamped into the row's `data` jsonb. The marker alone covers redelivery
 * of the *same* batch; the stamp covers the case where two different batches carrying the
 * same events reach the row, which the marker cannot see.
 */
export async function upsertSessionMetaBatch(
  tx: BatchTx,
  batchId: string,
  inputRows: SessionUpsertRow[],
): Promise<number> {
  if (inputRows.length === 0) return 0;

  const byKey = new Map<string, SessionUpsertRow>();
  for (const row of inputRows) {
    const k = `${row.websiteId}\0${row.sessionId}`;
    const prev = byKey.get(k);
    byKey.set(k, prev ? mergeSessionRows(prev, row) : row);
  }
  const rows = [...byKey.values()];

  const values = rows.map((row) => {
    const endMs = safeEpochMs(row.latestEventMs || row.tsMs);
    return {
      websiteId: String(row.websiteId ?? ""),
      sessionId: String(row.sessionId ?? ""),
      sequence: 0 as const,
      data: {
        _snc_re_end: endMs,
        _snc_re_fu: String(row.firstUrl ?? ""),
        _snc_re_lu: String(row.lastUrl ?? ""),
        _snc_re_b: batchId,
      } as Record<string, unknown>,
      browser: String(row.browser ?? ""),
      device: String(row.device ?? ""),
      os: String(row.os ?? ""),
      country: String(row.country ?? ""),
      entryPage: String(row.entryPage ?? ""),
      timestamp: new Date(safeEpochMs(row.tsMs)),
      // New session: entry page + URL transitions within the batch.
      pagesViewed: (Number(row.urlTransitions) || 0) + 1,
      durationSeconds: Number(row.durationSeconds) || 0,
      hasRageClicks: row.hasRageClicks === true,
      hasErrors: row.hasErrors === true,
    };
  });

  await tx
    .insert(sessionReplays)
    .values(values)
    .onConflictDoUpdate({
      target: [sessionReplays.websiteId, sessionReplays.sessionId, sessionReplays.sequence],
      set: {
        /**
         * Safe to apply unguarded on a repeat: every term is a max over values the
         * previous apply already folded in, so re-running it is a no-op.
         */
        durationSeconds: dsql.raw(`LEAST(86400, GREATEST(
          session_replays.duration_seconds,
          excluded.duration_seconds,
          GREATEST(0, EXTRACT(EPOCH FROM (
            COALESCE(
              CASE WHEN excluded.data ? '_snc_re_end' THEN
                to_timestamp((excluded.data->>'_snc_re_end')::bigint / 1000.0)
              ELSE NULL END,
              excluded.timestamp
            ) - session_replays.timestamp
          ))::INT)
        ))`),
        /**
         * Existing session: add this batch's transitions (excluded.pages_viewed − 1;
         * the +1 entry page only applies on first insert) plus 1 if the page changed
         * exactly at the batch boundary (previous batch's last URL ≠ this batch's first).
         *
         * The outer CASE is the redelivery guard. This is the one accumulating column in
         * the table, so a batch applied twice does not duplicate a row — it inflates a
         * number, with nothing in the result to distinguish it from real traffic.
         */
        pagesViewed: dsql.raw(`CASE
          WHEN session_replays.data->>'_snc_re_b' IS NOT DISTINCT FROM excluded.data->>'_snc_re_b'
            THEN session_replays.pages_viewed
          ELSE session_replays.pages_viewed
            + GREATEST(excluded.pages_viewed - 1, 0)
            + CASE WHEN COALESCE(session_replays.data->>'_snc_re_lu','') <> ''
                    AND COALESCE(excluded.data->>'_snc_re_fu','') <> ''
                    AND session_replays.data->>'_snc_re_lu' <> excluded.data->>'_snc_re_fu'
               THEN 1 ELSE 0 END
        END`),
        /** Carry _snc_re_lu/_snc_re_fu forward so the next batch's boundary check compares against THIS batch. */
        data: dsql.raw("excluded.data"),
        hasRageClicks: dsql.raw(
          "CASE WHEN excluded.has_rage_clicks THEN TRUE ELSE session_replays.has_rage_clicks END",
        ),
        hasErrors: dsql.raw(
          "CASE WHEN excluded.has_errors THEN TRUE ELSE session_replays.has_errors END",
        ),
        browser: dsql.raw(
          "CASE WHEN excluded.browser <> '' THEN excluded.browser ELSE session_replays.browser END",
        ),
        device: dsql.raw(
          "CASE WHEN excluded.device <> '' THEN excluded.device ELSE session_replays.device END",
        ),
        os: dsql.raw("CASE WHEN excluded.os <> '' THEN excluded.os ELSE session_replays.os END"),
        country: dsql.raw(
          "CASE WHEN excluded.country <> '' THEN excluded.country ELSE session_replays.country END",
        ),
        entryPage: dsql.raw(
          // Entry page is a session invariant: later batches begin at the page that
          // happened to be active when their upload was flushed, not the session's
          // first page. Fill a legacy/empty row once, then preserve the original.
          "CASE WHEN session_replays.entry_page <> '' THEN session_replays.entry_page ELSE excluded.entry_page END",
        ),
      },
    });

  return rows.length;
}

/** Server-side narrowing for the session list. Every field is optional. */
/** `%` and `_` are ILIKE wildcards; a user typing them means the literal character. */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The predicate shared by the page query and its count.
 *
 * Built once rather than written twice: the two have to agree or the total is a lie
 * about the rows being paged through.
 */
function sessionListWhere(websiteId: string, filters: SessionListFilters) {
  const parts = [pgSql`website_id = ${websiteId}`, pgSql`sequence = 0`];

  if (filters.device) {
    parts.push(pgSql`lower(COALESCE(device,'')) = ${filters.device.toLowerCase()}`);
  }
  if (filters.hasErrors) parts.push(pgSql`has_errors = TRUE`);
  if (filters.hasRageClicks) parts.push(pgSql`has_rage_clicks = TRUE`);

  const search = filters.search?.trim();
  if (search) {
    const t = likeTerm(search);
    parts.push(pgSql`(
      session_id ILIKE ${t} ESCAPE '\\'
      OR COALESCE(country,'') ILIKE ${t} ESCAPE '\\'
      OR COALESCE(browser,'') ILIKE ${t} ESCAPE '\\'
      OR COALESCE(os,'') ILIKE ${t} ESCAPE '\\'
      OR COALESCE(device,'') ILIKE ${t} ESCAPE '\\'
      OR COALESCE(entry_page,'') ILIKE ${t} ESCAPE '\\'
    )`);
  }

  return parts.reduce((acc, part) => pgSql`${acc} AND ${part}`);
}

/**
 * One page of recorded sessions, newest first.
 *
 * No `DISTINCT ON`: `(website_id, session_id, sequence)` is the primary key, so
 * `sequence = 0` already yields exactly one row per session. The dedup that used to be
 * here forced two sorts over every session on the site before the `LIMIT` could apply;
 * without it the plan is an index scan backwards over `ix_session_replays_site_seq_ts`.
 */
export async function listSessions(
  websiteId: string,
  limit: number,
  offset: number,
  filters: SessionListFilters = {},
): Promise<SessionMetaRow[]> {
  return pgSql<SessionMetaRow[]>`
    SELECT
      session_id AS "sessionId", website_id AS "websiteId",
      COALESCE(browser,'') AS browser, COALESCE(device,'') AS device, COALESCE(os,'') AS os,
      COALESCE(country,'') AS country, COALESCE(entry_page,'') AS "entryPage",
      timestamp AS "startedAt", has_rage_clicks AS "hasRageClicks", has_errors AS "hasErrors",
      duration_seconds AS "durationSeconds", pages_viewed AS "pagesViewed"
    FROM session_replays
    WHERE ${sessionListWhere(websiteId, filters)}
    ORDER BY timestamp DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/** Totals over every session matching the filters, not just the page being shown. */
/**
 * Aggregate over the whole filtered set, ignoring the page window.
 *
 * A separate statement rather than `COUNT(*) OVER ()` on the page query: the window
 * function would have to materialise every matching row before the `LIMIT`, which is
 * exactly the full scan the page query was rewritten to avoid.
 *
 * All four numbers come from one scan, so the errors and rage counts are free next to
 * the total. That matters because the dashboard renders them as headline figures, and
 * computing them from the rows it happened to download made each one a statistic about
 * the first page rather than about the site.
 */
export async function summarizeSessions(
  websiteId: string,
  filters: SessionListFilters = {},
): Promise<SessionListSummary> {
  const rows = await pgSql<
    { total: number; with_errors: number; with_rage: number; avg_duration: number }[]
  >`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE has_errors)::int AS with_errors,
      COUNT(*) FILTER (WHERE has_rage_clicks)::int AS with_rage,
      COALESCE(ROUND(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0)), 0)::int
        AS avg_duration
    FROM session_replays
    WHERE ${sessionListWhere(websiteId, filters)}
  `;
  const row = rows[0];
  return {
    total: row?.total ?? 0,
    withErrors: row?.with_errors ?? 0,
    withRageClicks: row?.with_rage ?? 0,
    avgDurationSeconds: row?.avg_duration ?? 0,
  };
}

export async function getSessionMeta(
  websiteId: string,
  sessionId: string,
): Promise<SessionMetaRow | null> {
  const rows = await pgSql<SessionMetaRow[]>`
    SELECT session_id as "sessionId", website_id as "websiteId",
      COALESCE(browser,'') as browser, COALESCE(device,'') as device, COALESCE(os,'') as os,
      COALESCE(country,'') as country, COALESCE(entry_page,'') as "entryPage",
      timestamp as "startedAt", has_rage_clicks as "hasRageClicks", has_errors as "hasErrors",
      duration_seconds as "durationSeconds", pages_viewed as "pagesViewed"
    FROM session_replays
    WHERE session_id = ${sessionId} AND sequence = 0
      AND website_id = ${websiteId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Delete one session's rows. */
export async function deleteSession(websiteId: string, sessionId: string): Promise<void> {
  await pgSql`
    DELETE FROM session_replays
    WHERE website_id = ${websiteId} AND session_id = ${sessionId}
  `;
}
