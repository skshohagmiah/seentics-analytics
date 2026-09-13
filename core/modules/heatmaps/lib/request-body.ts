import type { Context } from "hono";
import type { AuthVars } from "../../../platform/middleware/auth";

/**
 * Hand-rolled body reading for the screenshot endpoints.
 *
 * These routes coerce every field with a fallback rather than rejecting — a missing
 * viewport means "use the default", not "bad request" — so they parse the envelope
 * themselves instead of going through a zod validator like the rest of the module.
 *
 * Shared by the screenshot and capture controllers.
 * rather than closed over inside one of the two factories.
 */

export async function readJsonBody(
  c: Context<{ Variables: AuthVars }>,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  try {
    return { ok: true, body: (await c.req.json()) as Record<string, unknown> };
  } catch {
    return { ok: false, res: c.json({ error: "invalid json" }, 400) };
  }
}

/** Numeric field with a fallback for absent, non-numeric, or infinite values. */
export function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
