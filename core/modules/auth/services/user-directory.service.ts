import type { FrontendUser, UserDirectory, UserProfile } from "../interfaces";
import type { UserRepository } from "../interfaces/user-repository.interface";
import { toFrontendUser } from "../lib/user-presenter";

/**
 * `UserDirectory` over the `users` table.
 *
 * A mapper over `UserRepository` — the narrow-projection queries it used to hold
 * directly now live in the repository beside every other `users` read, which is what
 * keeps `db` confined to a single file in this module.
 *
 * The projection still matters: `getProfileForClient` is the only method here that
 * reads a whole row, and it exists because the signed-in user's own client needs the
 * wide shape. Everything a *peer* module sees goes through `UserProfile`, which has no
 * password hash to leak.
 */
export class UserDirectoryService implements UserDirectory {
  constructor(private readonly users: UserRepository) {}

  async getById(userId: string): Promise<UserProfile | null> {
    return this.users.profileById(userId);
  }

  async getProfileForClient(userId: string): Promise<FrontendUser | null> {
    const row = await this.users.findById(userId);
    return row ? toFrontendUser(row) : null;
  }

  async findByEmail(email: string): Promise<UserProfile | null> {
    return this.users.profileByEmail(email.trim().toLowerCase());
  }

  async listByIds(userIds: readonly string[]): Promise<Map<string, UserProfile>> {
    return this.users.profilesByIds(userIds);
  }
}
