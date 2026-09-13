import type { WebsitesModule } from "../websites/interfaces";
import type { AiModule } from "./interfaces";
import { AiUsageCounter } from "./services/usage-count.service";
import { createAiRoutes } from "./routes";
import { NaturalLanguageQueryService } from "./services/natural-language-query.service";
import { OpenAiLlmClient } from "./services/openai-llm-client.service";
import { PostgresAiRepository } from "./repositories/postgres-ai.repository";

/**
 * Build the AI module.
 *
 * Purely a consumer: it reads through other modules' query surfaces and offers no
 * capability anything else needs, which is why `AiModule` is just its routes.
 */
export function initAiModule(deps: { websitesModule: WebsitesModule }): AiModule {
  // One repository for both: the usage counter reads the same table.
  const repo = new PostgresAiRepository();
  const runner = new NaturalLanguageQueryService(repo, new OpenAiLlmClient());

  return {
    usage: new AiUsageCounter(repo),
    routes: createAiRoutes({
      query: runner,
      history: runner,
      websites: deps.websitesModule.accessChecks,
    }),
  };
}
