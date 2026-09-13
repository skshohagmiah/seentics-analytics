import type { Context, Env } from "hono";
import { parseJson } from "../../../platform/validation";
import type { AuthControllerDeps } from "./auth-controller.types";
import { authLoginSchema, authRefreshSchema, authRegisterSchema } from "../validators/auth.schema";

export function register(deps: AuthControllerDeps) {
  return async (c: Context<Env>) => {
    const parsed = await parseJson(c, authRegisterSchema);
    if (!parsed.ok) return parsed.res;
    const { email, password, name } = parsed.data;
    try {
      return c.json(await deps.credentials.register({ email, password, name: name ?? "" }), 201);
    } catch {
      return c.json({ error: "Registration failed" }, 400);
    }
  };
}

export function login(deps: AuthControllerDeps) {
  return async (c: Context<Env>) => {
    const parsed = await parseJson(c, authLoginSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json(await deps.credentials.login(parsed.data));
    } catch {
      return c.json({ error: "invalid credentials" }, 401);
    }
  };
}

export function refresh(deps: AuthControllerDeps) {
  return async (c: Context<Env>) => {
    const parsed = await parseJson(c, authRefreshSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json(await deps.credentials.refresh(parsed.data.refresh_token.trim()));
    } catch {
      return c.json({ error: "invalid refresh token" }, 401);
    }
  };
}
