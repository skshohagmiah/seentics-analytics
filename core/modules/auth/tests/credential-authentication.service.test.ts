import { beforeEach, describe, expect, it } from "bun:test";
import { verifyAccessToken, verifyRefreshToken } from "../../../platform/lib/auth-jwt";
import { signRefreshToken } from "../../../platform/lib/auth-jwt";
import { AuthAccountQueryService } from "../services/auth-account-query.service";
import { CredentialAuthenticationService } from "../services/credential-authentication.service";
import { FakePasswordHasher, FakeUserRepository } from "./fake-user-repository";

/**
 * Registration, sign-in and refresh.
 *
 * None of this could be tested before `UserRepository` existed — the service held `db`
 * directly, so every rule below was live on the product's only unauthenticated write
 * path with nothing asserting it. The two that matter most are the first-user-becomes-
 * admin decision and the fact that a disabled account cannot sign in or refresh.
 */

/**
 * Both are set at module scope, before any import-time or test-time `env()` call.
 *
 * `platform/lib/auth-jwt` resolves the signing key through the real `config`, and
 * `env()` validates the whole environment — so a missing `DATABASE_URL` fails token
 * signing with an error about the database. Setting them here rather than mocking
 * `config` keeps this file from installing a global module stub: Bun's `mock.module`
 * applies to the entire run, so a partial config stub breaks unrelated files.
 */
process.env.DATABASE_URL ??= "postgres://test-not-connected";
process.env.JWT_SECRET = "test-secret-value-that-is-long-enough-for-hs256";

let repo: FakeUserRepository;
let auth: CredentialAuthenticationService;

beforeEach(() => {
  repo = new FakeUserRepository();
  auth = new CredentialAuthenticationService(repo, new FakePasswordHasher());
});

const REGISTRATION = {
  email: "person@example.com",
  password: "correct horse battery",
  name: "A Person",
};

describe("register", () => {
  describe("the first account", () => {
    /** An empty install has to produce someone who can administer it. */
    it("becomes admin", async () => {
      await auth.register(REGISTRATION);
      expect(repo.rows[0]!.role).toBe("admin");
    });

    it("and only the first — everyone after is a plain user", async () => {
      await auth.register(REGISTRATION);
      await auth.register({ ...REGISTRATION, email: "second@example.com" });
      await auth.register({ ...REGISTRATION, email: "third@example.com" });

      expect(repo.rows.map((r) => r.role)).toEqual(["admin", "user", "user"]);
    });
  });

  describe("normalisation", () => {
    it("lower-cases and trims the email before storing", async () => {
      await auth.register({ ...REGISTRATION, email: "  PERSON@Example.COM  " });
      expect(repo.rows[0]!.email).toBe("person@example.com");
    });

    it("treats a differently-cased address as the same account", async () => {
      await auth.register(REGISTRATION);
      expect(auth.register({ ...REGISTRATION, email: "PERSON@EXAMPLE.COM" })).rejects.toThrow();
    });

    it("falls back to the email local part when no name is given", async () => {
      await auth.register({ ...REGISTRATION, name: "   " });
      expect(repo.rows[0]!.name).toBe("person");
    });
  });

  describe("storage", () => {
    it("never stores the plaintext password", async () => {
      await auth.register(REGISTRATION);
      const stored = repo.rows[0]!;
      expect(stored.passwordHash).toBe("hashed:correct horse battery");
      expect(stored.passwordHash).not.toBe(REGISTRATION.password);
    });
  });

  describe("failure", () => {
    /**
     * A distinct "email already registered" would make this unauthenticated endpoint an
     * oracle for which addresses hold accounts.
     */
    it("reports a taken email the same way as any other failure", async () => {
      await auth.register(REGISTRATION);
      expect(auth.register(REGISTRATION)).rejects.toThrow("registration failed");
    });

    it("reports a lost insert race the same way", async () => {
      repo.createReturnsNull = true;
      expect(auth.register(REGISTRATION)).rejects.toThrow("registration failed");
    });
  });

  describe("result", () => {
    it("returns the new user signed in", async () => {
      const out = await auth.register(REGISTRATION);

      expect(out.data.user.email).toBe("person@example.com");
      expect(await verifyAccessToken(out.data.tokens.access_token)).toEqual({
        userId: repo.rows[0]!.id,
      });
    });

    it("does not leak the password hash into the response", async () => {
      const out = await auth.register(REGISTRATION);
      expect(JSON.stringify(out)).not.toContain("hashed:");
    });
  });
});

describe("login", () => {
  beforeEach(async () => {
    await auth.register(REGISTRATION);
  });

  it("accepts the right password", async () => {
    const out = await auth.login({ email: REGISTRATION.email, password: REGISTRATION.password });
    expect(out.data.user.email).toBe("person@example.com");
  });

  it("accepts a differently-cased email", async () => {
    const out = await auth.login({
      email: "  PERSON@EXAMPLE.com ",
      password: REGISTRATION.password,
    });
    expect(out.data.user.email).toBe("person@example.com");
  });

  it("refuses the wrong password", async () => {
    expect(
      auth.login({ email: REGISTRATION.email, password: "wrong" }),
    ).rejects.toThrow("invalid credentials");
  });

  it("refuses an unknown email with the same message", async () => {
    // Same message as a wrong password: a different one enumerates accounts.
    expect(
      auth.login({ email: "nobody@example.com", password: REGISTRATION.password }),
    ).rejects.toThrow("invalid credentials");
  });

  describe("a disabled account", () => {
    beforeEach(() => {
      repo.rows[0]!.isActive = false;
    });

    it("cannot sign in", async () => {
      expect(
        auth.login({ email: REGISTRATION.email, password: REGISTRATION.password }),
      ).rejects.toThrow("account disabled");
    });

    /**
     * The password is checked first on purpose, so someone without it cannot learn that
     * an address exists but is disabled — they get `invalid credentials` either way.
     */
    it("is indistinguishable from a wrong password to someone who lacks it", async () => {
      expect(
        auth.login({ email: REGISTRATION.email, password: "wrong" }),
      ).rejects.toThrow("invalid credentials");
    });
  });

  describe("sign-in bookkeeping", () => {
    it("increments the login count", async () => {
      await auth.login({ email: REGISTRATION.email, password: REGISTRATION.password });
      await auth.login({ email: REGISTRATION.email, password: REGISTRATION.password });
      expect(repo.rows[0]!.loginCount).toBe(2);
    });

    it("reports the updated count rather than the stale one", async () => {
      const out = await auth.login({
        email: REGISTRATION.email,
        password: REGISTRATION.password,
      });
      expect(out.data.user.loginCount).toBe(1);
    });

    it("does not record a sign-in for a failed attempt", async () => {
      await auth.login({ email: REGISTRATION.email, password: "wrong" }).catch(() => {});
      expect(repo.rows[0]!.loginCount).toBe(0);
    });
  });
});

describe("refresh", () => {
  let userId: string;

  beforeEach(async () => {
    await auth.register(REGISTRATION);
    userId = repo.rows[0]!.id;
  });

  it("issues a new pair for a valid refresh token", async () => {
    const first = await auth.login({
      email: REGISTRATION.email,
      password: REGISTRATION.password,
    });

    const next = await auth.refresh(first.data.tokens.refresh_token);
    expect(await verifyAccessToken(next.access_token)).toEqual({ userId });
    expect(await verifyRefreshToken(next.refresh_token)).toEqual({ userId });
  });

  it("refuses an access token in place of a refresh token", async () => {
    const out = await auth.login({ email: REGISTRATION.email, password: REGISTRATION.password });
    expect(auth.refresh(out.data.tokens.access_token)).rejects.toThrow();
  });

  /**
   * The token stays cryptographically valid for its full seven days, so re-reading
   * `isActive` here is the only thing that ends an existing session when an account is
   * disabled.
   */
  it("refuses a still-valid token once the account is disabled", async () => {
    const token = await signRefreshToken(userId);
    repo.rows[0]!.isActive = false;
    expect(auth.refresh(token)).rejects.toThrow("account disabled");
  });

  it("refuses a token for a user that no longer exists", async () => {
    const token = await signRefreshToken("user-that-was-deleted");
    expect(auth.refresh(token)).rejects.toThrow("account disabled");
  });

  it("refuses a garbage token", async () => {
    expect(auth.refresh("not.a.token")).rejects.toThrow();
  });
});

describe("countUsers", () => {
  it("reports zero on an empty install", async () => {
    expect(await new AuthAccountQueryService(repo).countUsers()).toBe(0);
  });

  it("counts registrations", async () => {
    await auth.register(REGISTRATION);
    await auth.register({ ...REGISTRATION, email: "second@example.com" });
    expect(await new AuthAccountQueryService(repo).countUsers()).toBe(2);
  });
});
