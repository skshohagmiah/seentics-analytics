import { and, desc, eq, isNull } from "drizzle-orm";
import { db, websiteInvitations, websiteMembers } from "../../../db";
import type { UserDirectory } from "../../auth/interfaces";
import { normalizeWebsiteRole, roleAtLeast, type WebsiteInvitations, type WebsiteRole } from "../interfaces";

function forbiddenRole(): Error & { status: number } {
  return Object.assign(new Error("forbidden"), { status: 403 });
}

function invitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function presentInvitation(row: typeof websiteInvitations.$inferSelect) {
  return {
    id: row.id,
    websiteId: row.websiteId,
    email: row.email,
    role: row.role,
    token: row.token,
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Invitation creation, administration, and token acceptance. */
export class WebsiteInvitationService implements WebsiteInvitations {
  constructor(private readonly directory: UserDirectory) {}

  async create(
    actorUserId: string,
    actorRole: WebsiteRole,
    websiteId: string,
    body: { email: string; role: string },
  ) {
    const grantedRole = normalizeWebsiteRole(body.role);
    if (!roleAtLeast(actorRole, grantedRole)) throw forbiddenRole();
    const email = body.email.trim().toLowerCase();
    await db.delete(websiteInvitations).where(and(
      eq(websiteInvitations.websiteId, websiteId),
      eq(websiteInvitations.email, email),
      isNull(websiteInvitations.acceptedAt),
    ));
    const [invitation] = await db.insert(websiteInvitations).values({
      websiteId,
      email,
      role: grantedRole,
      token: invitationToken(),
      invitedBy: actorUserId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).returning();
    return { data: presentInvitation(invitation!) };
  }

  async list(websiteId: string) {
    const rows = await db
      .select()
      .from(websiteInvitations)
      .where(and(eq(websiteInvitations.websiteId, websiteId), isNull(websiteInvitations.acceptedAt)))
      .orderBy(desc(websiteInvitations.createdAt));
    return { data: rows.map(presentInvitation) };
  }

  async revoke(websiteId: string, invitationId: string): Promise<void> {
    await db.delete(websiteInvitations).where(and(
      eq(websiteInvitations.id, invitationId),
      eq(websiteInvitations.websiteId, websiteId),
    ));
  }

  async acceptByToken(userId: string, token: string): Promise<{ data: { websiteId: string } }> {
    const [invitation] = await db
      .select()
      .from(websiteInvitations)
      .where(eq(websiteInvitations.token, token))
      .limit(1);
    if (!invitation) throw Object.assign(new Error("Invalid or expired invitation link"), { status: 404 });
    if (invitation.acceptedAt) throw Object.assign(new Error("Invitation has already been accepted"), { status: 400 });
    if (new Date() > invitation.expiresAt) throw Object.assign(new Error("Invitation has expired"), { status: 400 });
    const user = await this.directory.getById(userId);
    if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw Object.assign(
        new Error(`This invitation was sent to ${invitation.email}. Please sign in with that account.`),
        { status: 403 },
      );
    }
    const [existing] = await db.select().from(websiteMembers).where(and(
      eq(websiteMembers.websiteId, invitation.websiteId),
      eq(websiteMembers.userId, userId),
    )).limit(1);
    if (existing) {
      await db.update(websiteMembers)
        .set({ role: invitation.role, updatedAt: new Date() })
        .where(eq(websiteMembers.id, existing.id));
    } else {
      await db.insert(websiteMembers).values({
        websiteId: invitation.websiteId,
        userId,
        role: invitation.role,
      });
    }
    await db.update(websiteInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(websiteInvitations.id, invitation.id));
    return { data: { websiteId: invitation.websiteId } };
  }
}
