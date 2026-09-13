import { Hono } from "hono";
import { authMiddleware, type AuthVars } from "../../platform/middleware/auth";
import type { AiControllerDeps } from "./controllers/ai-controller.types";
import { getAiHistory } from "./controllers/ai-history.controller";
import { queryAi } from "./controllers/ai-query.controller";

export function createAiRoutes(deps: AiControllerDeps) {
  const routes = new Hono<{ Variables: AuthVars }>();
  routes.use("*", authMiddleware);
  routes.post("/query/:website_id", queryAi(deps));
  routes.get("/history/:website_id", getAiHistory(deps));
  return routes;
}
