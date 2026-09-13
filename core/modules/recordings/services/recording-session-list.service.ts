import {
  listSessions,
  summarizeSessions,
} from "../repositories/recording.repository";
import type { SessionListFilters } from "../interfaces";
import { clampListParams, timestampToIso } from "./recording-query-normalization.service";

/**
 * One page of recorded sessions, newest first, plus totals over the whole filtered set.
 *
 * `summary` exists because the dashboard used to fetch a fixed 100 rows and render
 * `rows.length` as "Total Sessions" — a number that silently stopped counting at 100 and
 * made every headline figure on the page a statistic about the first page.
 *
 * Filtering is server-side for the same reason: a search that only sees the rows already
 * downloaded reports "no results" for sessions that exist.
 */
export async function listReplaySessions(
  websiteId: string,
  limit: number,
  offset: number,
  filters: SessionListFilters = {},
) {
  const { limit: lim, offset: off } = clampListParams(limit, offset);
  const [sessions, summary] = await Promise.all([
    listSessions(websiteId, lim, off, filters),
    summarizeSessions(websiteId, filters),
  ]);
  const out = sessions.map((s) => ({
    sessionId: s.sessionId,
    websiteId: s.websiteId,
    browser: s.browser,
    device: s.device,
    os: s.os,
    country: s.country,
    entryPage: s.entryPage,
    startedAt: timestampToIso(s.startedAt),
    hasRageClicks: s.hasRageClicks,
    hasErrors: s.hasErrors,
    durationSeconds: s.durationSeconds,
    pagesViewed: s.pagesViewed,
  }));
  return { sessions: out, limit: lim, offset: off, total: summary.total, summary };
}

/**
 * Raw API variant: snake_case rows for that surface's response shape.
 *
 * The raw API's key middleware already resolved the website in order to authenticate the
 * request, so resolving again here was a second lookup for an answer the caller was holding.
 */
export async function listReplaySessionsRaw(
  websiteId: string,
  limit: number,
  offset: number,
) {
  const { limit: lim, offset: off } = clampListParams(limit, offset);
  const [sessions, summary] = await Promise.all([
    listSessions(websiteId, lim, off),
    summarizeSessions(websiteId),
  ]);
  return {
    limit: lim,
    offset: off,
    total: summary.total,
    sessions: sessions.map((s) => ({
      session_id: s.sessionId,
      website_id: s.websiteId,
      browser: s.browser,
      device: s.device,
      os: s.os,
      country: s.country,
      entry_page: s.entryPage,
      started_at: timestampToIso(s.startedAt),
      duration_seconds: s.durationSeconds,
      pages_viewed: s.pagesViewed,
      has_rage_clicks: s.hasRageClicks,
      has_errors: s.hasErrors,
    })),
  };
}
