import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context, Next } from "hono";
import { AuthAccountQueryService } from "../services/auth-account-query.service";
import { CredentialAuthenticationService } from "../services/credential-authentication.service";
import { FakePasswordHasher, FakeUserRepository } from "./fake-user-repository";

/**
 * The auth HTTP surface.
 *
 * `auth.service.test.ts` covers the rules; nothing covered the routes, and the routes are
 * where three things live that the service cannot express:
 *
 * 1. **The errors are deliberately uniform.** Registration answers one 400 whatever went
 *    wrong, and login answers one 401. That is what stops the endpoints from reporting
 *    whether an address has an account — an unauthenticated user-enumeration oracle on
 *    the product's only open write path. A `try/catch` that starts forwarding the
 *    service's message would undo it silently, so the shape is pinned here.
 * 2. **The surface is mounted twice.** `/api/v1/auth` and `/api/v1/user/auth` expose the
 *    same register/login/refresh trio, for deployed snippets and the web client
 *    respectively. They were hand-written copies once, and a change to one applied to
 *    half the surface. `registerCredentialRoutes` defines them once — these tests run
 *    the same assertions against both routers so a divergence fails.
 * 3. **Several endpoints are declared but not built.** Password reset and every OAuth
 *    path answer 501 on purpose, so a client gets "not built" rather than "no such
 *    route". The web app ships full UI against the two password-reset endpoints, so this
 *    is load-bearing information rather than a placeholder.
 */

process.env.DATABASE_URL ??= "postgres://test-not-connected";
process.env.JWT_SECRET = "test-secret-value-that-is-long-enough-for-hs256";

/**
 * A permissive `authMiddleware`, so `/me` can be driven by header.
 *
 * Complete — both runtime exports — because `mock.module` applies to the whole run; see
 * `app/tests/mock-completeness.test.ts`.
 */
mock.module("../../../platform/middleware/auth", () => ({
  authMiddleware: async (c: Context<{ Variables: { userId: string } }>, next: Next) => {
    const userId = c.req.header("X-Test-User");
    if (!userId) return c.json({ error: "Authorization required" }, 401);
    c.set("userId", userId);
    return next();
  },
  requireUser: (c: Context<{ Variables: { userId: string } }>) => c.get("userId") ?? null,
}));

const { createAuthRoutes, createUserAuthRoutes } = await import("../routes");

let repo: FakeUserRepository;
let auth: CredentialAuthenticationService;
let publicRouter: ReturnType<typeof createAuthRoutes>;
let userRouter: ReturnType<typeof createUserAuthRoutes>;

beforeEach(() => {
  repo = new FakeUserRepository();
  auth = new CredentialAuthenticationService(repo, new FakePasswordHasher());
  const deps = { credentials: auth, accounts: new AuthAccountQueryService(repo) };
  publicRouter = createAuthRoutes(deps);
  userRouter = createUserAuthRoutes(deps);
});

/** Matches `Hono.request`, which is typed as returning either form. */
type Router = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

function post(router: Router, path: string, body: unknown, headers: Record<string, string> = {}) {
  return router.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(router: Router, path: string, headers: Record<string, string> = {}) {
  return router.request(path, { headers });
}

/** The `FakePasswordHasher` convention, so a seeded row can actually sign in. */
function hashOf(password: string): string {
  return `hashed:${password}`;
}

const GOOD = { email: "person@example.com", password: "correct horse battery" };

describe("the credential trio, on both mounts", () => {
  /**
   * Every assertion in here runs against both routers.
   *
   * The two mounts existed as duplicate handlers, so "works on /auth" and "works on
   * /user/auth" were genuinely independent facts. They are now one implementation, and
   * this loop is what keeps that true.
   */
  const mounts: { name: string; router: () => Router }[] = [
    { name: "/auth", router: () => publicRouter },
    { name: "/user/auth", router: () => userRouter },
  ];

  for (const mount of mounts) {
    describe(`${mount.name} register`, () => {
      it("creates the account and answers 201", async () => {
        const res = await post(mount.router(), "/register", { ...GOOD, name: "A Person" });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.user.email).toBe(GOOD.email);
        expect(body.data.tokens.access_token).toBeTruthy();
      });

      it("returns the account signed in, so the client needs no second call", async () => {
        const res = await post(mount.router(), "/register", GOOD);
        const body = await res.json();

        expect(body.data.tokens.refresh_token).toBeTruthy();
      });

      it("never returns the password hash", async () => {
        const res = await post(mount.router(), "/register", GOOD);

        expect(await res.text()).not.toContain("hashed:");
      });

      it("rejects a duplicate address with the same uniform 400", async () => {
        // The point of the uniform error: this response must be indistinguishable from
        // any other registration failure, or it reports which addresses exist.
        await post(mount.router(), "/register", GOOD);

        const res = await post(mount.router(), "/register", GOOD);

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Registration failed" });
      });

      it("rejects a password under the minimum length", async () => {
        const res = await post(mount.router(), "/register", { ...GOOD, password: "short" });

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "validation_error" });
        expect(repo.rows).toHaveLength(0);
      });

      it("accepts a password exactly at the minimum length", async () => {
        const res = await post(mount.router(), "/register", { ...GOOD, password: "12345678" });

        expect(res.status).toBe(201);
      });

      it("rejects a malformed address", async () => {
        const res = await post(mount.router(), "/register", { ...GOOD, email: "not-an-email" });

        expect(res.status).toBe(400);
        expect(repo.rows).toHaveLength(0);
      });

      it("rejects a missing password rather than creating a passwordless account", async () => {
        const res = await post(mount.router(), "/register", { email: GOOD.email });

        expect(res.status).toBe(400);
        expect(repo.rows).toHaveLength(0);
      });

      it("accepts an absent name and derives one from the address", async () => {
        // Signup does not ask for a name, so the display name has to come from
        // somewhere — the local part, rather than an empty string the UI would render
        // as a blank account menu.
        const res = await post(mount.router(), "/register", GOOD);

        expect(res.status).toBe(201);
        expect(repo.rows[0]!.name).toBe("person");
      });

      it("derives a name from a whitespace-only one too", async () => {
        const res = await post(mount.router(), "/register", { ...GOOD, name: "   " });

        expect(res.status).toBe(201);
        expect(repo.rows[0]!.name).toBe("person");
      });

      it("keeps a supplied name", async () => {
        await post(mount.router(), "/register", { ...GOOD, name: "A Person" });

        expect(repo.rows[0]!.name).toBe("A Person");
      });

      it("rejects a name past the length bound", async () => {
        const res = await post(mount.router(), "/register", {
          ...GOOD,
          name: "n".repeat(121),
        });

        expect(res.status).toBe(400);
      });

      it("rejects a malformed body", async () => {
        const res = await post(mount.router(), "/register", "{not json");

        expect(res.status).toBe(400);
        expect(repo.rows).toHaveLength(0);
      });

      it("distinguishes a validation failure from a service failure", async () => {
        // Both are 400, but only the validation one carries `issues` — the client can
        // point at a field for one and not the other.
        const invalid = await post(mount.router(), "/register", { ...GOOD, email: "nope" });
        await post(mount.router(), "/register", GOOD);
        const duplicate = await post(mount.router(), "/register", GOOD);

        expect(await invalid.json()).toMatchObject({ error: "validation_error" });
        expect(await duplicate.json()).toEqual({ error: "Registration failed" });
      });
    });

    describe(`${mount.name} login`, () => {
      beforeEach(() => {
        repo.seed({ email: GOOD.email, passwordHash: hashOf(GOOD.password) });
      });

      it("returns the user and a token pair", async () => {
        const res = await post(mount.router(), "/login", GOOD);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.user.email).toBe(GOOD.email);
        expect(body.data.tokens.access_token).toBeTruthy();
        expect(body.data.tokens.refresh_token).toBeTruthy();
      });

      it("answers the same 401 for a wrong password and an unknown address", async () => {
        // The core of the enumeration guard. If these two ever differ, the endpoint
        // reports which addresses have accounts.
        const wrongPassword = await post(mount.router(), "/login", {
          ...GOOD,
          password: "not it",
        });
        const unknownUser = await post(mount.router(), "/login", {
          email: "nobody@example.com",
          password: GOOD.password,
        });

        expect(wrongPassword.status).toBe(401);
        expect(unknownUser.status).toBe(401);
        expect(await wrongPassword.json()).toEqual(await unknownUser.json());
      });

      it("says only 'invalid credentials'", async () => {
        const res = await post(mount.router(), "/login", { ...GOOD, password: "not it" });

        expect(await res.json()).toEqual({ error: "invalid credentials" });
      });

      it("refuses a disabled account with the same 401", async () => {
        repo.rows[0]!.isActive = false;

        const res = await post(mount.router(), "/login", GOOD);

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "invalid credentials" });
      });

      it("never returns the password hash", async () => {
        const res = await post(mount.router(), "/login", GOOD);

        expect(await res.text()).not.toContain("hashed:");
      });

      it("matches the address case-insensitively", async () => {
        // Addresses are lowercased on the way in, so a capitalised sign-in has to work
        // or the account is unreachable from a phone keyboard.
        const res = await post(mount.router(), "/login", {
          ...GOOD,
          email: "Person@Example.COM",
        });

        expect(res.status).toBe(200);
      });

      it("rejects a malformed address before reaching the repository", async () => {
        const res = await post(mount.router(), "/login", { ...GOOD, email: "nope" });

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "validation_error" });
      });

      it("rejects an empty password rather than comparing against one", async () => {
        const res = await post(mount.router(), "/login", { ...GOOD, password: "" });

        expect(res.status).toBe(400);
      });

      it("rejects a malformed body", async () => {
        const res = await post(mount.router(), "/login", "]]]");

        expect(res.status).toBe(400);
      });

      it("answers 400 for a validation failure, not 401", async () => {
        // A malformed request is the client's bug; a 401 would send them looking for a
        // credential problem that does not exist.
        const res = await post(mount.router(), "/login", {});

        expect(res.status).toBe(400);
      });
    });

    describe(`${mount.name} refresh`, () => {
      it("exchanges a valid refresh token for a new pair", async () => {
        repo.seed({ email: GOOD.email, passwordHash: hashOf(GOOD.password) });
        const login = await post(mount.router(), "/login", GOOD);
        const { refresh_token } = (await login.json()).data.tokens;

        const res = await post(mount.router(), "/refresh", { refresh_token });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.access_token).toBeTruthy();
        expect(body.refresh_token).toBeTruthy();
      });

      it("rejects a garbage token with 401", async () => {
        const res = await post(mount.router(), "/refresh", { refresh_token: "not-a-jwt" });

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "invalid refresh token" });
      });

      it("refuses to refresh a disabled account", async () => {
        // The whole point of a short access token: disabling an account has to take
        // effect at the next refresh rather than whenever the token happens to expire.
        repo.seed({ email: GOOD.email, passwordHash: hashOf(GOOD.password) });
        const login = await post(mount.router(), "/login", GOOD);
        const { refresh_token } = (await login.json()).data.tokens;

        repo.rows[0]!.isActive = false;

        const res = await post(mount.router(), "/refresh", { refresh_token });

        expect(res.status).toBe(401);
      });

      it("does not accept an access token in place of a refresh token", async () => {
        // The two are signed for different purposes. Accepting either would make a
        // stolen access token renewable indefinitely.
        repo.seed({ email: GOOD.email, passwordHash: hashOf(GOOD.password) });
        const login = await post(mount.router(), "/login", GOOD);
        const { access_token } = (await login.json()).data.tokens;

        const res = await post(mount.router(), "/refresh", { refresh_token: access_token });

        expect(res.status).toBe(401);
      });

      it("tolerates surrounding whitespace on the token", async () => {
        repo.seed({ email: GOOD.email, passwordHash: hashOf(GOOD.password) });
        const login = await post(mount.router(), "/login", GOOD);
        const { refresh_token } = (await login.json()).data.tokens;

        const res = await post(mount.router(), "/refresh", {
          refresh_token: `  ${refresh_token}  `,
        });

        expect(res.status).toBe(200);
      });

      it("rejects a blank token as a validation failure", async () => {
        const res = await post(mount.router(), "/refresh", { refresh_token: "   " });

        expect(res.status).toBe(400);
      });

      it("rejects a missing token", async () => {
        const res = await post(mount.router(), "/refresh", {});

        expect(res.status).toBe(400);
      });

      it("rejects a token past the length bound rather than verifying it", async () => {
        const res = await post(mount.router(), "/refresh", {
          refresh_token: "x".repeat(4097),
        });

        expect(res.status).toBe(400);
      });
    });
  }

  it("answers identically on both mounts for the same rejected login", async () => {
    // Asserted directly rather than inferred from the loop above: the two mounts share
    // an implementation, and this is the test that fails if one of them is ever
    // re-implemented by hand.
    repo.seed({ email: GOOD.email, passwordHash: hashOf(GOOD.password) });

    const viaPublic = await post(publicRouter, "/login", { ...GOOD, password: "wrong" });
    const viaUser = await post(userRouter, "/login", { ...GOOD, password: "wrong" });

    expect(viaPublic.status).toBe(viaUser.status);
    expect(await viaPublic.json()).toEqual(await viaUser.json());
  });
});

describe("GET /user/auth/me", () => {
  it("returns the caller's own profile", async () => {
    const row = repo.seed({ email: GOOD.email, passwordHash: hashOf(GOOD.password) });

    const res = await get(userRouter, "/me", { "X-Test-User": row.id });

    expect(res.status).toBe(200);
    expect((await res.json()).data.user.email).toBe(GOOD.email);
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await get(userRouter, "/me");

    expect(res.status).toBe(401);
  });

  it("answers 404 for a token naming a user that no longer exists", async () => {
    // A deleted account with a still-valid access token. 404 rather than 401 is what
    // the client turns into a logout.
    const res = await get(userRouter, "/me", { "X-Test-User": "user-does-not-exist" });

    expect(res.status).toBe(404);
  });

  it("never returns the password hash", async () => {
    const row = repo.seed({ email: GOOD.email, passwordHash: hashOf(GOOD.password) });

    const res = await get(userRouter, "/me", { "X-Test-User": row.id });

    expect(await res.text()).not.toContain("hashed:");
  });

  it("reads the profile for the caller's own id, not one from the request", async () => {
    // There is no path parameter here on purpose: `/me` must be unable to read anyone
    // else's profile.
    const mine = repo.seed({ email: "me@example.com", passwordHash: hashOf("a") });
    repo.seed({ email: "someone@example.com", passwordHash: hashOf("b") });

    const res = await get(userRouter, "/me", { "X-Test-User": mine.id });

    expect((await res.json()).data.user.email).toBe("me@example.com");
  });

  it("is not mounted on the public router", async () => {
    // `/api/v1/auth` establishes a session; it has no session to report.
    const res = await get(publicRouter, "/me", { "X-Test-User": "anyone" });

    expect(res.status).toBe(404);
  });
});

describe("GET /user/auth/setup-status", () => {
  it("reports an empty install as not set up", async () => {
    const res = await get(userRouter, "/setup-status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { setupComplete: false } });
  });

  it("reports an install with a user as set up", async () => {
    repo.seed({ email: GOOD.email, passwordHash: hashOf(GOOD.password) });

    const res = await get(userRouter, "/setup-status");

    expect(await res.json()).toEqual({ data: { setupComplete: true } });
  });

  it("is reachable without a session", async () => {
    // It has to be: the first-run screen asks this question before anyone can sign in.
    const res = await get(userRouter, "/setup-status");

    expect(res.status).toBe(200);
  });

  it("does not leak how many users exist", async () => {
    // A boolean, not a count. The count would tell an anonymous caller the size of the
    // install.
    repo.seed({ email: "a@example.com", passwordHash: hashOf("a") });
    repo.seed({ email: "b@example.com", passwordHash: hashOf("b") });
    repo.seed({ email: "c@example.com", passwordHash: hashOf("c") });

    const body = await (await get(userRouter, "/setup-status")).text();

    expect(body).toEqual(JSON.stringify({ data: { setupComplete: true } }));
  });
});

describe("POST /user/auth/verify-secrets", () => {
  it("reports not verified, since it is stubbed", async () => {
    const res = await post(userRouter, "/verify-secrets", {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { verified: false } });
  });

  it("accepts an object body with unknown keys", async () => {
    const res = await post(userRouter, "/verify-secrets", { anything: "at all" });

    expect(res.status).toBe(200);
  });

  it("rejects a non-object body", async () => {
    // Validated even though the endpoint is stubbed, so a client that starts sending a
    // body learns about a malformed one now rather than when this is built.
    const res = await post(userRouter, "/verify-secrets", "[1,2,3]");

    expect(res.status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const res = await post(userRouter, "/verify-secrets", "{oops");

    expect(res.status).toBe(400);
  });

  it("never reports verified, whatever it is sent", async () => {
    // Guards against this being wired to echo the request while still a stub.
    const res = await post(userRouter, "/verify-secrets", { verified: true });

    expect((await res.json()).data.verified).toBe(false);
  });
});

describe("declared but not implemented", () => {
  /**
   * These answer 501 so a client gets "not built" instead of "no such route" — and the
   * distinction matters more than usual here, because the web app ships complete UI
   * against both password-reset endpoints (`/forgot-password`, `/reset-password`) and
   * a Google callback page against the OAuth ones. The pages surface the failure; see
   * `web/e2e/auth-session.spec.ts`.
   *
   * When any of these is built, its test here fails, which is the intended signal.
   */

  it("answers 501 for forgot-password", async () => {
    const res = await post(publicRouter, "/forgot-password", { email: GOOD.email });

    expect(res.status).toBe(501);
  });

  it("answers 501 for reset-password", async () => {
    const res = await post(publicRouter, "/reset-password", {
      token: "t",
      newPassword: "12345678",
    });

    expect(res.status).toBe(501);
  });

  it("answers 501 rather than starting a Google flow", async () => {
    const res = await get(userRouter, "/google");

    expect(res.status).toBe(501);
  });

  it("answers 501 rather than starting a GitHub flow", async () => {
    const res = await get(userRouter, "/github");

    expect(res.status).toBe(501);
  });

  it("answers 501 for the Google callback", async () => {
    const res = await get(userRouter, "/google/callback?code=abc");

    expect(res.status).toBe(501);
  });

  it("says to use email and password instead", async () => {
    // The message is the only guidance a client gets, so it is part of the contract.
    const res = await get(userRouter, "/google");

    expect((await res.json()).error).toContain("email/password");
  });

  it("creates no account from an OAuth callback", async () => {
    await get(userRouter, "/google/callback?code=abc");

    expect(repo.rows).toHaveLength(0);
  });

  it("does not mount the password-reset stubs on the session router", async () => {
    // They live on `/api/v1/auth` only. Pinning where they are, so a client written
    // against the wrong mount fails loudly rather than getting a 404 it reads as a
    // deployment problem.
    const res = await post(userRouter, "/forgot-password", { email: GOOD.email });

    expect(res.status).toBe(404);
  });
});
