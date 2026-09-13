/**
 * Public contracts for the auth module.
 *
 * Auth owns `users`. `UserDirectory` is the only capability peers need — nothing
 * outside this module has any business with password hashes or token signing.
 */
export type { FrontendUser, UserProfile, UserDirectory } from "./auth.interface";

/**
 * Storage and hashing, exported for this module's own composition and tests only.
 * No peer has any reason to hold either — `UserDirectory` above is the peer surface.
 */
export type {
  NewUser,
  UserProfileRow,
  UserRepository,
  UserRow,
} from "./user-repository.interface";
export type { PasswordHasher } from "./password-hasher.interface";
export type {
  AuthAccountQuery,
  AuthResult,
  AuthTokens,
  CredentialAuthentication,
} from "./authentication.interface";

/** The whole module surface, as a peer receives it at composition time. */
export type { AuthModule } from "./auth.module";
