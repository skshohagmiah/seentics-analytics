import { and, asc, eq } from "drizzle-orm";
import { db, websiteMembers } from "../../../db";
import type { AddWebsiteMemberBody } from "../../../platform/lib/api-types";
import type { UserDirectory } from "../../auth/interfaces";
import { normalizeWebsiteRole, roleAtLeast, type WebsiteRole } from "../interfaces";

function forbiddenRole(): Error & { status: number } {
  return Object.assign(new Error("forbidden"), { status: 403 });
}

/** Membership operations after the controller has authorized the acting user. */
export class WebsiteMemberService {
  constructor(private readonly directory: UserDirectory) {}

  private async targetRole(websiteId: string, userId: string): Promise<WebsiteRole | null> {
    const [member] = await db
      .select({ role: websiteMembers.role })
      .from(websiteMembers)
      .where(and(eq(websiteMembers.websiteId, websiteId), eq(websiteMembers.userId, userId)))
      .limit(1);
    return member ? normalizeWebsiteRole(member.role) : null;
  }

  private async assertOutranks(
    actorRole: WebsiteRole,
    websiteId: string,
    targetUserId: string,
  ): Promise<void> {
    if (actorRole === "owner") return;
    const targetRole = await this.targetRole(websiteId, targetUserId);
    if (!targetRole) return;
    if (!roleAtLeast(actorRole, targetRole) || actorRole === targetRole) throw forbiddenRole();
  }

  async list(websiteId: string) {
    const rows = await db
      .select({
        id: websiteMembers.id,
        websiteId: websiteMembers.websiteId,
        userId: websiteMembers.userId,
        role: websiteMembers.role,
        createdAt: websiteMembers.createdAt,
      })
      .from(websiteMembers)
      .where(eq(websiteMembers.websiteId, websiteId))
      .orderBy(asc(websiteMembers.createdAt));
    const people = await this.directory.listByIds(rows.map((member) => member.userId));
    return {
      data: rows.map((member) => ({
        id: member.id,
        websiteId: member.websiteId,
        userId: member.userId,
        role: member.role,
        createdAt: member.createdAt.toISOString(),
        userName: people.get(member.userId)?.name ?? "",
        userEmail: people.get(member.userId)?.email ?? "",
      })),
    };
  }

  async add(websiteId: string, actorRole: WebsiteRole, body: AddWebsiteMemberBody) {
    const grantedRole = normalizeWebsiteRole(body.role);
    if (!roleAtLeast(actorRole, grantedRole)) throw forbiddenRole();
    const target = await this.directory.findByEmail(body.email);
    if (!target) throw new Error("user not found");
    const [existing] = await db
      .select()
      .from(websiteMembers)
      .where(and(eq(websiteMembers.websiteId, websiteId), eq(websiteMembers.userId, target.id)))
      .limit(1);
    if (existing) return { data: existing };
    const [member] = await db
      .insert(websiteMembers)
      .values({ websiteId, userId: target.id, role: grantedRole })
      .returning();
    return { data: member };
  }

  async remove(
    websiteId: string,
    actorUserId: string,
    actorRole: WebsiteRole,
    targetUserId: string,
  ): Promise<void> {
    await this.assertOutranks(actorRole, websiteId, targetUserId);
    if (targetUserId === actorUserId) throw forbiddenRole();
    await db
      .delete(websiteMembers)
      .where(and(eq(websiteMembers.websiteId, websiteId), eq(websiteMembers.userId, targetUserId)));
  }

  async updateRole(
    websiteId: string,
    actorUserId: string,
    actorRole: WebsiteRole,
    targetUserId: string,
    role: string,
  ): Promise<void> {
    const grantedRole = normalizeWebsiteRole(role);
    if (!roleAtLeast(actorRole, grantedRole)) throw forbiddenRole();
    await this.assertOutranks(actorRole, websiteId, targetUserId);
    if (targetUserId === actorUserId) throw forbiddenRole();
    await db
      .update(websiteMembers)
      .set({ role: grantedRole, updatedAt: new Date() })
      .where(and(eq(websiteMembers.websiteId, websiteId), eq(websiteMembers.userId, targetUserId)));
  }
}
