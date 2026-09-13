import type { InferSelectModel } from "drizzle-orm";
import type { users } from "../../../db/schema";

export type UserRow = InferSelectModel<typeof users>;

/** Convert a persistence row into the user shape returned by HTTP endpoints. */
export function toFrontendUser(u: UserRow) {
  const id = u.id;
  return {
    email: u.email,
    name: u.name,
    avatar: u.avatarUrl ?? null,
    isEmailVerified: u.isEmailVerified,
    isActive: u.isActive,
    loginCount: u.loginCount,
    _id: id,
    id,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? "",
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    role: u.role,
    googleId: u.googleId ?? undefined,
    githubId: u.githubId ?? undefined,
  };
}
