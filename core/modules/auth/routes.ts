import { Hono } from "hono";
import { authMiddleware, type AuthVars } from "../../platform/middleware/auth";
import type { AuthedRouter, PublicRouter } from "../../platform/http/router";
import { currentUser, setupStatus, verifySecrets } from "./controllers/auth-account.controller";
import { login, refresh, register } from "./controllers/auth-credentials.controller";
import { notImplemented } from "./controllers/auth-placeholder.controller";
import type { AuthControllerDeps } from "./controllers/auth-controller.types";

function registerCredentials(routes: Hono<any>, deps: AuthControllerDeps) {
  routes.post("/register", register(deps));
  routes.post("/login", login(deps));
  routes.post("/refresh", refresh(deps));
}

export function createAuthRoutes(deps: AuthControllerDeps): PublicRouter {
  const routes = new Hono();
  registerCredentials(routes, deps);
  routes.post("/forgot-password", notImplemented());
  routes.post("/reset-password", notImplemented());
  return routes;
}

export function createUserAuthRoutes(deps: AuthControllerDeps): AuthedRouter {
  const routes = new Hono<{ Variables: AuthVars }>();
  registerCredentials(routes, deps);
  routes.get("/setup-status", setupStatus(deps));
  routes.get("/google", notImplemented("OAuth not configured; use email/password"));
  routes.get("/github", notImplemented("OAuth not configured; use email/password"));
  routes.get("/google/callback", notImplemented("OAuth not configured"));
  routes.get("/me", authMiddleware, currentUser(deps));
  routes.post("/verify-secrets", verifySecrets());
  return routes;
}
