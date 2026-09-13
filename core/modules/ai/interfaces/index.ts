/**
 * Public contracts for the ai module.
 *
 * Query execution and history are separate capabilities; website access belongs to
 * the HTTP boundary and is supplied by the websites module.
 */
export type {
  AiQuery,
  AiQueryExecution,
  AiQueryHistory,
  AIDomain,
  AIHistoryItem,
  AIQueryResult,
} from "./ai.interface";
export { AIDailyLimitError } from "./ai.interface";

/** The whole module surface, as a peer receives it at composition time. */
export type { AiModule } from "./ai.module";
