import { and, asc, eq, or, sql } from "drizzle-orm";
import {
  analyticsEvents,
  automations,
  db,
  funnels,
  goals,
  websiteMembers,
  websites,
} from "../../../db";
import { newTrackingId, newVerificationToken } from "../lib/ids";
import { normalizeWebsiteRole } from "../interfaces/website.interface";
import type {
  CreateWebsiteInput,
  UpdateWebsiteInput,
  Website,
  WebsiteRepository,
  WebsiteRole,
  WebsiteSettings,
} from "../interfaces";
import { normalizeHostname } from "../lib/hostname";

type WebsiteRow = typeof websites.$inferSelect;

/** Settings applied when a website has never had them customised. */
function defaultSettings(): WebsiteSettings {
  return {
    allowedOrigins: [],
    trackingEnabled: true,
    dataRetentionDays: 365,
    useIpAnonymization: false,
    respectDoNotTrack: false,
    allowRawDataExport: false,
  };
}

/**
 * Persistence row → domain model.
 *
 * The single place column names become domain names. `settingsJson` is nullable
 * for rows created before settings existed, so it falls back to defaults rather
 * than handing callers a null they would each have to guard.
 */
function toDomain(row: WebsiteRow): Website {
  return {
    id: row.id,
    ownerId: row.userId,
    name: row.name,
    url: row.url,
    trackingId: row.trackingId,
    isActive: row.isActive,
    isVerified: row.isVerified,
    automationEnabled: row.automationEnabled,
    funnelEnabled: row.funnelEnabled,
    heatmapEnabled: row.heatmapEnabled,
    heatmapIncludePatterns: row.heatmapIncludePatterns,
    heatmapExcludePatterns: row.heatmapExcludePatterns,
    heatmapLayoutEnabled: row.heatmapLayoutEnabled,
    replayEnabled: row.replayEnabled,
    replaySamplingRate: row.replaySamplingRate,
    replayIncludePatterns: row.replayIncludePatterns,
    replayExcludePatterns: row.replayExcludePatterns,
    verificationToken: row.verificationToken,
    publicShareId: row.publicShareId,
    settings: { ...defaultSettings(), ...((row.settingsJson as Partial<WebsiteSettings>) ?? {}) },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresWebsiteRepository implements WebsiteRepository {
  async findById(websiteId: string): Promise<Website | null> {
    const [row] = await db.select().from(websites).where(eq(websites.id, websiteId)).limit(1);
    return row ? toDomain(row) : null;
  }

  async listOwnedBy(ownerId: string): Promise<Website[]> {
    const rows = await db
      .select()
      .from(websites)
      .where(eq(websites.userId, ownerId))
      .orderBy(asc(websites.createdAt));
    return rows.map(toDomain);
  }

  async findRole(websiteId: string, userId: string): Promise<WebsiteRole | null> {
    // Owner and membership in one round trip. This runs on nearly every
    // authenticated request, so the join is worth it over two sequential reads.
    const [row] = await db
      .select({
        isOwner: sql<boolean>`${websites.userId} = ${userId}`,
        memberId: websiteMembers.id,
        memberRole: websiteMembers.role,
      })
      .from(websites)
      .leftJoin(
        websiteMembers,
        and(eq(websiteMembers.websiteId, websites.id), eq(websiteMembers.userId, userId)),
      )
      .where(eq(websites.id, websiteId))
      .limit(1);

    if (!row) return null;
    if (row.isOwner) return "owner";
    if (!row.memberId) return null;
    // The stored role, not a flat "member". Collapsing it here is what let a viewer
    // through every route that only checked for access at all.
    return normalizeWebsiteRole(row.memberRole);
  }

  async findByPublicShareId(
    publicShareId: string,
  ): Promise<{ websiteId: string } | null> {
    // The `IS NOT NULL` guard matters: a revoked link sets `publicShareId` to
    // NULL, and without it a caller passing an empty-ish value could match
    // those rows and reopen a dashboard the owner deliberately closed.
    const [row] = await db
      .select({ websiteId: websites.id })
      .from(websites)
      .where(
        and(eq(websites.publicShareId, publicShareId), sql`${websites.publicShareId} IS NOT NULL`),
      )
      .limit(1);
    return row ?? null;
  }

  async create(ownerId: string, input: CreateWebsiteInput): Promise<Website> {
    const host = normalizeHostname(input.url);

    // One transaction so a website can never exist without its owner membership
    // row — the row every access check depends on — and so the creation event is
    // durable with the website itself.
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(websites)
        .values({
          userId: ownerId,
          name: input.name.trim(),
          url: host,
          trackingId: newTrackingId(),
          verificationToken: newVerificationToken(),
          replayEnabled: true,
          replaySamplingRate: 1,
        })
        .returning();

      const created = toDomain(row!);

      await tx.insert(websiteMembers).values({
        websiteId: created.id,
        userId: ownerId,
        role: "owner",
      });


      return created;
    });
  }

  async update(websiteId: string, input: UpdateWebsiteInput): Promise<Website | null> {
    const patch = buildUpdatePatch(input);

    // Nothing to change: return current state rather than issuing an UPDATE that
    // would bump `updatedAt` for a no-op request.
    if (Object.keys(patch).length === 0) return this.findById(websiteId);

    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(websites)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(websites.id, websiteId))
        .returning();

      if (!row) return null;
      const updated = toDomain(row);


      return updated;
    });
  }

  async delete(websiteId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(websites).where(eq(websites.id, websiteId)).limit(1);
      if (!row) return false;

      // One identifier reaches every table. This block used to carry a warning that
      // `analytics_events` was keyed by a shorter id than the other four — mixing them
      // up deleted nothing and still reported success.
      await tx.delete(analyticsEvents).where(eq(analyticsEvents.websiteId, websiteId));
      await tx.delete(automations).where(eq(automations.websiteId, websiteId));
      await tx.delete(funnels).where(eq(funnels.websiteId, websiteId));
      await tx.delete(goals).where(eq(goals.websiteId, websiteId));
      await tx.delete(websiteMembers).where(eq(websiteMembers.websiteId, websiteId));


      await tx.delete(websites).where(eq(websites.id, websiteId));
      return true;
    });
  }

  async setPublicShareId(websiteId: string, shareId: string | null): Promise<string | null> {
    const [row] = await db
      .update(websites)
      .set({ publicShareId: shareId, updatedAt: new Date() })
      .where(eq(websites.id, websiteId))
      .returning({ publicShareId: websites.publicShareId });
    return row?.publicShareId ?? null;
  }
}

/**
 * Domain patch → column patch, dropping absent fields.
 *
 * `undefined` means "leave alone" and is omitted; `null` on a nullable pattern
 * column means "clear it" and is kept. Collapsing those two would make it
 * impossible to clear a pattern once set, so the nullable fields are checked
 * with `!== undefined` while the rest use `!= null`.
 */
function buildUpdatePatch(input: UpdateWebsiteInput): Partial<typeof websites.$inferInsert> {
  const patch: Partial<typeof websites.$inferInsert> = {};

  if (input.name != null) patch.name = input.name;
  if (input.url != null) patch.url = normalizeHostname(input.url);
  if (input.isActive != null) patch.isActive = input.isActive;
  if (input.automationEnabled != null) patch.automationEnabled = input.automationEnabled;
  if (input.funnelEnabled != null) patch.funnelEnabled = input.funnelEnabled;
  if (input.heatmapEnabled != null) patch.heatmapEnabled = input.heatmapEnabled;
  if (input.heatmapLayoutEnabled != null) patch.heatmapLayoutEnabled = input.heatmapLayoutEnabled;
  if (input.replayEnabled != null) patch.replayEnabled = input.replayEnabled;
  if (input.replaySamplingRate != null) patch.replaySamplingRate = input.replaySamplingRate;

  if (input.heatmapIncludePatterns !== undefined) {
    patch.heatmapIncludePatterns = input.heatmapIncludePatterns;
  }
  if (input.heatmapExcludePatterns !== undefined) {
    patch.heatmapExcludePatterns = input.heatmapExcludePatterns;
  }
  if (input.replayIncludePatterns !== undefined) {
    patch.replayIncludePatterns = input.replayIncludePatterns;
  }
  if (input.replayExcludePatterns !== undefined) {
    patch.replayExcludePatterns = input.replayExcludePatterns;
  }

  return patch;
}
