import { describe, expect, it } from "bun:test";
import { toFrontendUser, type UserRow } from "../lib/user-presenter";

/**
 * The row → response mapper.
 *
 * `toFrontendUser` is the only thing between a `users` row and an HTTP body, and the row
 * it receives is a `SELECT *` — `loginUser` and `refreshSession` both hand it everything
 * the table holds, `password_hash` included. It is safe today because it names its
 * output fields explicitly rather than spreading the row, and the point of the first
 * test is to keep it that way: a future `return { ...u, avatar: ... }` would look like a
 * tidy-up and would publish every user's bcrypt hash.
 *
 * So this is asserted as an allow-list — exact key equality, not "does not contain
 * passwordHash" — because that also catches a column added to the schema later and
 * spread into the response without anyone deciding it should be public.
 */

/** A row with every column populated, as `SELECT *` would return it. */
function row(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    email: "person@example.com",
    passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNO",
    name: "A Person",
    role: "user",
    avatarUrl: "https://example.com/a.png",
    isEmailVerified: true,
    isActive: true,
    loginCount: 7,
    lastLoginAt: new Date("2026-01-02T03:04:05.000Z"),
    googleId: "g-1",
    githubId: "gh-1",
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("toFrontendUser", () => {
  describe("what leaves the process", () => {
    it("emits exactly the intended fields and no others", () => {
      expect(Object.keys(toFrontendUser(row())).sort()).toEqual(
        [
          "_id",
          "avatar",
          "createdAt",
          "email",
          "githubId",
          "googleId",
          "id",
          "isActive",
          "isEmailVerified",
          "lastLoginAt",
          "loginCount",
          "name",
          "role",
          "updatedAt",
        ].sort(),
      );
    });

    it("never emits the password hash", () => {
      const out = toFrontendUser(row()) as Record<string, unknown>;
      expect(out.passwordHash).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain("$2a$");
    });
  });

  describe("field mapping", () => {
    it("exposes the id under both id and _id", () => {
      const out = toFrontendUser(row());
      expect(out.id).toBe("11111111-2222-3333-4444-555555555555");
      expect(out._id).toBe(out.id);
    });

    it("renames avatarUrl to avatar", () => {
      expect(toFrontendUser(row()).avatar).toBe("https://example.com/a.png");
    });

    it("carries role through unchanged", () => {
      expect(toFrontendUser(row({ role: "admin" })).role).toBe("admin");
    });
  });

  describe("absent values", () => {
    it("renders a null avatar as null rather than dropping it", () => {
      expect(toFrontendUser(row({ avatarUrl: null })).avatar).toBeNull();
    });

    it("renders a never-logged-in user's lastLoginAt as an empty string", () => {
      // The wire contract is a string; the column is nullable.
      expect(toFrontendUser(row({ lastLoginAt: null })).lastLoginAt).toBe("");
    });

    it("omits absent social ids", () => {
      const out = toFrontendUser(row({ googleId: null, githubId: null }));
      expect(out.googleId).toBeUndefined();
      expect(out.githubId).toBeUndefined();
    });
  });

  describe("timestamps", () => {
    it("serialises dates as ISO strings", () => {
      const out = toFrontendUser(row());
      expect(out.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(out.updatedAt).toBe("2026-02-02T00:00:00.000Z");
      expect(out.lastLoginAt).toBe("2026-01-02T03:04:05.000Z");
    });
  });
});
