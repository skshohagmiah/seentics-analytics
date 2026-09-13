import type { WebsiteQuery } from "../../websites/interfaces";
import type { AiQueryExecution, AiQueryHistory } from "../interfaces";

export type AiControllerDeps = {
  query: AiQueryExecution;
  history: AiQueryHistory;
  websites: WebsiteQuery;
};
