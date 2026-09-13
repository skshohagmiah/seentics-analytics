import type { Context } from "hono";
import { log } from "../../../platform/lib/logger";
import type { AuthVars } from "../../../platform/middleware/auth";
import { parseJson } from "../../../platform/validation";
import { AIDailyLimitError, type AIDomain } from "../interfaces";
import { aiQueryBodySchema } from "../validators/ai.schema";
import { requireAiAccess } from "./ai-access";
import type { AiControllerDeps } from "./ai-controller.types";

const aiLog = log.child({ category: "ai" });

export function queryAi(deps: AiControllerDeps) {
  return async (c: Context<{ Variables: AuthVars }, "/query/:website_id">) => {
    const websiteRef = c.req.param("website_id");
    const access = await requireAiAccess(c, deps, websiteRef);
    if ("denied" in access) return access.denied;
    const parsed = await parseJson(c, aiQueryBodySchema);
    if (!parsed.ok) return parsed.res;

    try {
      const domain = (parsed.data.domain ?? "analytics") as AIDomain;
      const result = await deps.query.run(access.userId, websiteRef, parsed.data.prompt, domain);
      return c.json({ data: result });
    } catch (err) {
      if (err instanceof AIDailyLimitError) {
        return c.json({ error: "Daily AI query limit reached. Try again later." }, 429);
      }
      const message = err instanceof Error ? err.message : "AI query failed";
      if (message.includes("not configured") || message.includes("API key")) {
        return c.json({ error: "AI is not available — API key not configured." }, 503);
      }
      aiLog.error({ msg: "ai_query_failed", website_id: websiteRef, err: message });
      return c.json({ error: "AI query failed" }, 500);
    }
  };
}
