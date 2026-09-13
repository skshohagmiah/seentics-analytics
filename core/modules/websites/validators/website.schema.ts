import { z } from "zod";
import { zNonEmptyString, zUrl } from "../../../platform/validation";

export const websiteCreateSchema = z.object({
  name: zNonEmptyString.max(120),
  url: zUrl,
});

export const websitePatchSchema = z.record(z.unknown());

export const goalCreateSchema = z.object({
  name: zNonEmptyString.max(120),
  type: zNonEmptyString.max(64),
  identifier: zNonEmptyString.max(256),
  selector: z.string().trim().max(1024).optional(),
});

export const goalPatchSchema = z.record(z.unknown());

/**
 * The four roles, as an enum rather than a free string.
 *
 * This accepted any non-empty string up to 32 characters, so `"owner"` sailed through
 * with nothing downstream comparing it to the caller's own role — and an unrecognised
 * value was stored verbatim, to be normalised to `viewer` only when read back. The
 * privilege rules live in `WebsiteMemberService`; this stops a nonsense role reaching
 * the table in the first place.
 */
export const websiteRoleSchema = z.enum(["owner", "admin", "member", "viewer"]);

export const memberAddSchema = z.object({
  email: zNonEmptyString.email().max(320),
  role: websiteRoleSchema.optional(),
});

/** Same shape as adding a member: an invitation is a deferred membership. */
export const invitationCreateSchema = z.object({
  email: zNonEmptyString.email().max(320),
  role: websiteRoleSchema.optional().default("viewer"),
});

export const memberRoleSchema = z.object({
  role: websiteRoleSchema,
});
