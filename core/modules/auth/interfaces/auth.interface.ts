/**
 * Public contracts for the auth module.
 *
 * Auth owns `users`, so anything that needs to read a person goes through here. Two
 * consumers do: the profile endpoint on the `/user` branch, and the websites module,
 * which shows collaborator names and resolves an invite by email address.
 */

/**
 * The signed-in user as the web client consumes them.
 *
 * Structurally what `toFrontendUser` returns; declared here so a consumer holds the
 * contract rather than importing the mapper. `_id` duplicates `id` for a client that
 * predates the rename.
 */
export type FrontendUser = {
  id: string;
  _id: string;
  email: string;
  name: string;
  avatar: string | null;
  isEmailVerified: boolean;
  isActive: boolean;
  loginCount: number;
  lastLoginAt: string;
  createdAt: string;
  updatedAt: string;
  role: string;
  googleId?: string;
  githubId?: string;
};

/** A user as other modules are allowed to see them — no password hash, no tokens. */
export type UserProfile = {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
};

/**
 * Reading people.
 *
 * `platform/http/user-profiles.ts` used to import `getUserById` straight out of
 * the former all-purpose auth service, which also held password hashing and token signing
 * live — so an HTTP file in the platform layer had a compile-time path to both.
 */
export interface UserDirectory {
  /** `null` when no such user. */
  getById(userId: string): Promise<UserProfile | null>;

  /**
   * The full wire shape the web client expects for a signed-in user.
   *
   * Separate from `getById` because it is much wider — avatar, verification and login
   * state, OAuth ids — and because that shape is auth's public API contract, not a
   * domain model. The mapping used to live in `platform/lib/user-mapper.ts` while three
   * of its four callers were in this module.
   */
  getProfileForClient(userId: string): Promise<FrontendUser | null>;

  /**
   * Look a user up by email, for invitations.
   *
   * Lower-cased before matching, because invitations are addressed by whatever the
   * inviter typed and `users.email` is stored canonically.
   */
  findByEmail(email: string): Promise<UserProfile | null>;

  /**
   * Names and emails for a set of user ids, keyed by id.
   *
   * Batched because the caller is a member list: a per-member lookup there is an N+1
   * on a page that renders every collaborator on a website.
   */
  listByIds(userIds: readonly string[]): Promise<Map<string, UserProfile>>;
}
