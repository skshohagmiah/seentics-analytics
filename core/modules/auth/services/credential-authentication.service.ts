import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../../platform/lib/auth-jwt";
import { toFrontendUser } from "../lib/user-presenter";
import type { LoginUserInput, RegisterUserInput } from "../../../platform/lib/api-types";
import type {
  AuthResult,
  AuthTokens,
  CredentialAuthentication,
} from "../interfaces";
import type { PasswordHasher } from "../interfaces/password-hasher.interface";
import type { UserRepository, UserRow } from "../interfaces/user-repository.interface";

/**
 * Registration, sign-in and session refresh.
 *
 * A class taking a `UserRepository` and a `PasswordHasher`, where this used to be a set
 * of module-level functions holding `db` and `bcrypt` directly. That is what makes the
 * rules below testable — every one of them was unverified before, on the only
 * unauthenticated write path in the product.
 *
 * Token signing stays a direct import: `platform/lib/auth-jwt` is a platform library
 * like the logger, not a peer module, and it holds no state a test needs to steer.
 */

/** The first account in an empty install administers it; everyone after is a user. */
const FIRST_USER_ROLE = "admin";
const DEFAULT_ROLE = "user";

export class CredentialAuthenticationService implements CredentialAuthentication {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  /**
   * Create an account and return it signed in.
   *
   * Every failure surfaces as the same `registration failed`, deliberately: a distinct
   * "email already registered" turns this endpoint into an oracle for which addresses
   * hold accounts, and it is unauthenticated.
   */
  async register(input: RegisterUserInput): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await this.hasher.hash(input.password);

    const row = await this.users.create({
      email,
      passwordHash,
      // Falling back to the local part keeps the display name non-empty without asking
      // for one at signup.
      name: input.name.trim() || email.split("@")[0]!,
      firstUserRole: FIRST_USER_ROLE,
      role: DEFAULT_ROLE,
    });

    if (!row) throw new Error("registration failed");
    return this.issue(row);
  }

  /**
   * Verify credentials and start a session.
   *
   * The password is checked before `isActive`, so a disabled account and a wrong
   * password are indistinguishable to someone who does not already hold the password.
   */
  async login(input: LoginUserInput): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    const row = await this.users.findByEmail(email);
    if (!row?.passwordHash) throw new Error("invalid credentials");

    const ok = await this.hasher.verify(input.password, row.passwordHash);
    if (!ok) throw new Error("invalid credentials");
    if (!row.isActive) throw new Error("account disabled");

    // The updated row carries the incremented `loginCount` the response reports.
    const fresh = (await this.users.recordLogin(row.id)) ?? row;
    return this.issue(fresh);
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * `isActive` is re-read here rather than trusted from the token: a token issued
   * before an account was disabled stays cryptographically valid for its full seven
   * days, so this is the only place that deactivation takes effect on an existing
   * session.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const { userId } = await verifyRefreshToken(refreshToken);
    const row = await this.users.findById(userId);
    if (!row?.isActive) throw new Error("account disabled");
    return this.tokensFor(row.id);
  }

  private async issue(row: UserRow): Promise<AuthResult> {
    return { data: { user: toFrontendUser(row), tokens: await this.tokensFor(row.id) } };
  }

  private async tokensFor(userId: string): Promise<AuthTokens> {
    const [access_token, refresh_token] = await Promise.all([
      signAccessToken(userId),
      signRefreshToken(userId),
    ]);
    return { access_token, refresh_token };
  }
}
