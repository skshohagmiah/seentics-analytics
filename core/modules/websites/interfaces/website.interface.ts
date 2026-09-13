/**
 * The websites module's public surface.
 *
 * Split by capability rather than exposed as one `IWebsitesModule`, so a
 * consumer depends only on what it uses. Automations needs to look a website up;
 * it has no business being able to delete one, and its constructor should say so.
 */

import type { TrafficSummary } from "../../analytics/interfaces";

/**
 * A website in domain form — camelCase, no persistence or transport concerns.
 *
 * One identifier: `id`, the UUID primary key, which every table in the system keys on.
 * There used to be a second — a short `website_id` that `analytics_events`,
 * `session_replays` and `ai_queries` used instead — and every read path paid for it
 * with a resolve step that turned one reference into a pair. Both columns and the
 * resolution are gone.
 */
export type Website = {
  id: string;
  ownerId: string;
  name: string;
  /** Bare hostname, no scheme and no leading `www.` — see `normalizeHostname`. */
  url: string;
  trackingId: string;
  isActive: boolean;
  isVerified: boolean;
  automationEnabled: boolean;
  funnelEnabled: boolean;
  heatmapEnabled: boolean;
  heatmapIncludePatterns: string | null;
  heatmapExcludePatterns: string | null;
  heatmapLayoutEnabled: boolean;
  replayEnabled: boolean;
  replaySamplingRate: number;
  replayIncludePatterns: string | null;
  replayExcludePatterns: string | null;
  verificationToken: string;
  /** Non-null when a public dashboard link is active. */
  publicShareId: string | null;
  settings: WebsiteSettings;
  createdAt: Date;
  updatedAt: Date;
};

export type WebsiteSettings = {
  allowedOrigins: string[];
  trackingEnabled: boolean;
  dataRetentionDays: number;
  useIpAnonymization: boolean;
  respectDoNotTrack: boolean;
  allowRawDataExport: boolean;
};

/**
 * A user's relationship to a website. `null` means no access.
 *
 * `website_members.role` is a free-form `varchar(32)` with no database enum, so this is
 * the set the code recognises rather than a constraint the table enforces. Anything
 * stored that is not recognised normalises to `viewer` — the least privileged value —
 * because these strings gate destructive operations.
 */
export type WebsiteRole = "owner" | "admin" | "member" | "viewer";

/** Map a stored `website_members.role` onto a known role, failing closed. */
export function normalizeWebsiteRole(raw: string | null | undefined): WebsiteRole {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "owner":
      return "owner";
    case "admin":
      return "admin";
    case "member":
      return "member";
    default:
      return "viewer";
  }
}

/**
 * May this role destroy collected data — delete recordings, heatmaps, or analytics?
 *
 * Read access and delete access used to be the same check: every route asked only
 * whether `getRole` returned non-null, and the repository collapsed every stored role to
 * `"member"`, so a collaborator invited as a viewer could permanently delete a site's
 * session recordings. Recordings are the sharpest case — they replay what a real visitor
 * did on screen and there is no undo — but the predicate is deliberately shared.
 */
export function roleCanDeleteData(role: WebsiteRole): boolean {
  return roleAtLeast(role, "member");
}

/**
 * The roles in order of privilege, least first.
 *
 * Indexes into this array are the comparison — see `roleAtLeast`. Adding a role means
 * putting it in the right place here and nowhere else.
 */
const ROLE_ORDER: readonly WebsiteRole[] = ["viewer", "member", "admin", "owner"];

/**
 * Does `role` carry at least the privilege of `minimum`?
 *
 * The predicate every website-scoped operation is supposed to run, and for most of them
 * it did not exist. `assertWebsiteAccess` asked whether a membership row existed and
 * never read its `role` column, so a viewer could delete the website, publish its
 * analytics, add members, and set their own role to owner — the last of those in a
 * single request, because nothing compared the caller's role to the one being granted.
 *
 * `roleCanDeleteData` was the one place that got this right, and it guarded exactly one
 * endpoint. Expressing the comparison once, here, is what stops the next operation from
 * being added without one.
 */
export function roleAtLeast(role: WebsiteRole, minimum: WebsiteRole): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimum);
}

export type CreateWebsiteInput = {
  name: string;
  /** Accepts a bare host or full URL; normalized to a hostname on write. */
  url: string;
};

/**
 * Fields a website update may change, all optional.
 *
 * `null` is meaningful for the pattern fields — it clears them — so those are
 * `string | null` while absence means "leave alone". Distinguishing the two is
 * why this is not simply `Partial<Website>`.
 */
export type UpdateWebsiteInput = {
  name?: string;
  url?: string;
  isActive?: boolean;
  automationEnabled?: boolean;
  funnelEnabled?: boolean;
  heatmapEnabled?: boolean;
  heatmapIncludePatterns?: string | null;
  heatmapExcludePatterns?: string | null;
  heatmapLayoutEnabled?: boolean;
  replayEnabled?: boolean;
  replaySamplingRate?: number;
  replayIncludePatterns?: string | null;
  replayExcludePatterns?: string | null;
};

/**
 * Read access to websites — the interface other modules should depend on.
 *
 * ```ts
 * class AutomationService {
 *   constructor(private websites: WebsiteQuery) {}
 * }
 * ```
 */
export interface WebsiteQuery {
  /** `null` when no website matches. */
  getById(websiteId: string): Promise<Website | null>;

  /** Every website the user owns, oldest first. */
  listOwnedBy(ownerId: string): Promise<Website[]>;

  /**
   * The user's role on the website, or `null` for no access.
   *
   * Prefer this over comparing `ownerId` yourself — it also covers members,
   * which owner comparison silently excludes.
   */
  getRole(websiteId: string, userId: string): Promise<WebsiteRole | null>;
}

/** Write access. Held by the websites module's own routes, not by peer modules. */
export interface WebsiteMutations {
  create(ownerId: string, input: CreateWebsiteInput): Promise<Website>;

  /** `null` when the website does not exist. */
  update(websiteId: string, input: UpdateWebsiteInput): Promise<Website | null>;

  /** `false` when there was nothing to delete. */
  delete(websiteId: string): Promise<boolean>;

  /** Enable or disable the public dashboard link; returns the share id or null. */
  setPublicSharing(websiteId: string, enabled: boolean): Promise<string | null>;
}

/**
 * Resolution of public dashboard share links.
 *
 * Separate from `WebsiteQuery` because the caller is anonymous: the public
 * dashboard has a share id and nothing else, and must not be able to reach the
 * by-id or by-owner lookups that assume an authenticated user.
 */
export interface WebsitePublicSharing {
  /**
   * The website behind an active share link, or `null` when the link is unknown or
   * has been revoked.
   *
   * Returns only the id — a public caller has no business receiving the owner,
   * verification token, or settings that the full `Website` carries.
   */
  resolvePublicShareId(publicShareId: string): Promise<{ websiteId: string } | null>;
}


/** A website with its trailing-30-day figures attached. */
export type WebsiteWithTraffic = Website & { traffic: TrafficSummary };

/**
 * Reads that embed traffic figures.
 *
 * Separate from `WebsiteQuery` because these are the only reads that fan out to
 * the analytics port, and because no peer module wants them — the dashboard's own
 * routes are the sole caller.
 */
export interface WebsiteTrafficReads {
  /** Every website the user owns, each with its summary. Batched, not N+1. */
  listOwnedWithTraffic(ownerId: string): Promise<WebsiteWithTraffic[]>;

  /** One website with traffic. The HTTP controller performs access checks first. */
  getWithTraffic(websiteId: string): Promise<WebsiteWithTraffic | null>;
}
