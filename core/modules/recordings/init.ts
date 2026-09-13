import { recordingsLane } from "./ingest-lane";
import type { WebsitesModule } from "../websites/interfaces";
import type { RecordingsModule } from "./interfaces";
import { RecordingUsageCounter } from "./services/usage-count.service";
import { createRecordingRoutes } from "./routes";
import { RecordingRawReadService } from "./services/recording-raw-read.service";
import {
  recordingIngestService,
  stopRecordingIngestService,
} from "./services/recording-ingest.service";
import { batchDeleteReplaySessions } from "./services/recording-session-deletion.service";
import { getReplaySessionDetail } from "./services/recording-session-detail.service";
import { listReplaySessions } from "./services/recording-session-list.service";
import { RecordingRetentionPurge } from "./services/retention-purge.service";

/** Build the recordings module. */
export function initRecordingsModule(deps: {
  websitesModule: WebsitesModule;
}): RecordingsModule {
  return {
    lane: recordingsLane(() => recordingIngestService()),

    // This module's own accessor, called here rather than reached for by ingest — which is
    // what removed ingest's edge into a process-wide singleton it could not stub.
    ingest: () => recordingIngestService(),
    retention: new RecordingRetentionPurge(),
    usage: new RecordingUsageCounter(),
    rawReads: new RecordingRawReadService(),
    routes: createRecordingRoutes({
      recordingList: { listSessions: listReplaySessions },
      recordingDetails: { getSessionDetail: getReplaySessionDetail },
      recordingDeletion: { batchDelete: batchDeleteReplaySessions },
      websites: deps.websitesModule.accessChecks,
    }),

    // Constructing the service arms the chunk flush timer and opens a storage client, so
    // it happens here rather than at build time — same reason as the heatmap engine. The
    // accessor is idempotent: an ingest that beat `start()` already built one, and
    // replacing it would strand that timer and whatever it had buffered.
    start() {
      recordingIngestService();
    },

    // Never constructs one just to tear it down — `recordingIngestService().shutdown()` would.
    async stop() {
      await stopRecordingIngestService();
    },
  };
}
