import type { PublicRouter } from "../../../platform/http/router";
import type { ModuleLifecycle } from "../../../app/module";
import type { IngestQueue } from "./index";

/** Everything the ingest module offers. */
export interface IngestModule extends ModuleLifecycle {
  /**
   * The same buffer `/collect` writes into.
   *
   * Exposed because the `/internal` collectors accept the same data over a server-to-server
   * API, and routing them through the queue rather than straight at the writers gives them
   * the same batching, retry and exactly-once handling for free.
   */
  queue: IngestQueue;

  /** No auth context: the tracker is anonymous by design. */
  routes: PublicRouter;
}
