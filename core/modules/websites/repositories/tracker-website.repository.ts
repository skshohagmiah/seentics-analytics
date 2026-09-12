import type { AppConfig } from "../../../config";
import { sql } from "../../../db";
import { MemoryCache } from "../../../platform/lib/memory-cache";
import type { TrackerGoal, WebsiteTrackerRow } from "../interfaces";


const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let websiteResolveCache: MemoryCache<WebsiteTrackerRow | null> | null = null;
let websiteResolveCacheTtlMs = 180_000;

/** Call once at process start (see `index.ts`) so lookups reuse TTL-cached rows (including “not found”). */
export function configureTrackerWebsiteCache(cfg: AppConfig): void {
  if (!cfg.trackerCache.enabled) {
    websiteResolveCache = null;
    return;
  }
  websiteResolveCache = new MemoryCache<WebsiteTrackerRow | null>(cfg.trackerCache.maxEntries);
  websiteResolveCacheTtlMs = cfg.trackerCache.websiteTtlMs;
}

/**
 * Load a website by the id the tracker sends: either `websites.id` (UUID) or `websites.website_id`.
 * Uses an in-memory TTL cache when `configureTrackerWebsiteCache` ran with cache enabled.
 */
export async function resolveWebsiteForTracker(
  websiteParam: string,
): Promise<WebsiteTrackerRow | null> {
  const p = websiteParam.trim();
  if (!p) return null;

  if (websiteResolveCache) {
    if (Math.random() < 0.05) websiteResolveCache.sweepExpired();
    const hit = websiteResolveCache.get(p);
    if (hit !== undefined) return hit;
  }

  const rows = uuidRe.test(p)
    ? await sql<WebsiteTrackerRow[]>`
        SELECT
          websites.id::text AS id,
          websites.user_id::text AS user_id,
          websites.url,
          websites.is_active,
          websites.funnel_enabled,
          websites.heatmap_enabled,
          websites.heatmap_include_patterns,
          websites.heatmap_exclude_patterns,
          websites.heatmap_layout_enabled,
          websites.replay_enabled,
          websites.replay_sampling_rate,
          websites.replay_include_patterns,
          websites.replay_exclude_patterns,
          websites.automation_enabled,
          COALESCE(privacy.respect_dnt, false) AS respect_dnt,
          COALESCE(privacy.consent_mode, 'cookieless') AS consent_mode
        FROM websites
        LEFT JOIN website_privacy_settings privacy ON privacy.site_id = websites.id::text
        WHERE websites.id = ${p}::uuid
        LIMIT 1
      `
    : await sql<WebsiteTrackerRow[]>`
        SELECT
          websites.id::text AS id,
          websites.user_id::text AS user_id,
          websites.url,
          websites.is_active,
          websites.funnel_enabled,
          websites.heatmap_enabled,
          websites.heatmap_include_patterns,
          websites.heatmap_exclude_patterns,
          websites.heatmap_layout_enabled,
          websites.replay_enabled,
          websites.replay_sampling_rate,
          websites.replay_include_patterns,
          websites.replay_exclude_patterns,
          websites.automation_enabled,
          COALESCE(privacy.respect_dnt, false) AS respect_dnt,
          COALESCE(privacy.consent_mode, 'cookieless') AS consent_mode
        FROM websites
        LEFT JOIN website_privacy_settings privacy ON privacy.site_id = websites.id::text
        WHERE websites.website_id = ${p}
        LIMIT 1
      `;

  const row = rows[0] ?? null;
  if (websiteResolveCache) {
    websiteResolveCache.set(p, row, websiteResolveCacheTtlMs);
  }
  return row;
}


export async function listTrackerGoals(websiteId: string): Promise<TrackerGoal[]> {
  return sql<TrackerGoal[]>`
    SELECT id::text AS id, identifier AS name, selector AS selector
    FROM goals
    WHERE website_id = ${websiteId}::uuid
      AND type = 'event'
      AND selector IS NOT NULL
      AND btrim(selector) <> ''
    ORDER BY created_at ASC
  `;
}

export async function buildPublicTrackerConfig(
  w: WebsiteTrackerRow,
  goals: TrackerGoal[],
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    website_id: w.id,
    funnel_enabled: w.funnel_enabled,
    goals: goals.map((g) => ({ id: g.id, name: g.name, selector: g.selector })),
    replay_enabled: w.replay_enabled,
    replay_sampling_rate: w.replay_sampling_rate,
    replay_include_patterns: w.replay_include_patterns,
    replay_exclude_patterns: w.replay_exclude_patterns,
    heatmap_enabled: w.heatmap_enabled,
    heatmap_layout_enabled: w.heatmap_layout_enabled,
    respect_dnt: w.respect_dnt,
    consent_mode: w.consent_mode,
  };
  if (w.heatmap_include_patterns) {
    out.heatmap_include_patterns = w.heatmap_include_patterns;
  }
  if (w.heatmap_exclude_patterns) {
    out.heatmap_exclude_patterns = w.heatmap_exclude_patterns;
  }
  return out;
}
