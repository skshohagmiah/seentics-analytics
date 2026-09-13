import type { AuthModule } from "./interfaces";
import { PostgresUserRepository } from "./repositories/postgres-user.repository";
import { AuthAccountQueryService } from "./services/auth-account-query.service";
import { CredentialAuthenticationService } from "./services/credential-authentication.service";
import { BcryptPasswordHasher } from "./services/bcrypt-password-hasher.service";
import { UserDirectoryService } from "./services/user-directory.service";
import { createAuthRoutes, createUserAuthRoutes } from "./routes";

/**
 * Build the auth module.
 *
 * Takes nothing: auth depends on no other module. It exists so the two consumers of
 * `users` — the profile endpoint and the websites member list — receive a port instead
 * of importing the credential-authentication implementation, which is also where password hashing and
 * token signing live.
 *
 * The repository is shared by both services on purpose: `UserDirectory` reads the same
 * table, and giving it its own handle would put a second `db` import back in the module.
 */
export function initAuthModule(): AuthModule {
  const users = new PostgresUserRepository();
  const credentials = new CredentialAuthenticationService(users, new BcryptPasswordHasher());
  const accounts = new AuthAccountQueryService(users);
  const controllers = { credentials, accounts };

  return {
    users: new UserDirectoryService(users),
    routes: createAuthRoutes(controllers),
    userRoutes: createUserAuthRoutes(controllers),
  };
}
