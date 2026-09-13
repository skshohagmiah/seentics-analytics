import { and, asc, eq } from "drizzle-orm";
import { db, goals } from "../../../db";
import type { CreateGoalBody, UpdateGoalPatch } from "../../../platform/lib/api-types";

export async function listWebsiteGoals(websiteId: string) {
  const rows = await db
    .select()
    .from(goals)
    .where(eq(goals.websiteId, websiteId))
    .orderBy(asc(goals.createdAt));
  return {
    data: rows.map((g) => ({
      id: g.id,
      website_id: g.websiteId,
      name: g.name,
      type: g.type,
      identifier: g.identifier,
      selector: g.selector,
      revenue: g.revenue,
      currency: g.currency,
      created_at: g.createdAt.toISOString(),
      updated_at: g.updatedAt.toISOString(),
    })),
  };
}

export async function createWebsiteGoal(websiteId: string, body: CreateGoalBody) {
  const [g] = await db
    .insert(goals)
    .values({
      websiteId: websiteId,
      name: body.name,
      type: body.type,
      identifier: body.identifier,
      selector: body.selector ?? null,
    })
    .returning();
  return { data: g };
}

export async function updateWebsiteGoal(
  websiteId: string,
  goalId: string,
  body: UpdateGoalPatch,
) {
  const [g] = await db
    .update(goals)
    .set({
      ...(body.name != null ? { name: body.name } : {}),
      ...(body.type != null ? { type: body.type } : {}),
      ...(body.identifier != null ? { identifier: body.identifier } : {}),
      ...(body.selector !== undefined ? { selector: body.selector } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(goals.id, goalId), eq(goals.websiteId, websiteId)))
    .returning();
  return g ? { data: g } : null;
}

export async function deleteWebsiteGoal(websiteId: string, goalId: string) {
  await db.delete(goals).where(and(eq(goals.id, goalId), eq(goals.websiteId, websiteId)));
}
