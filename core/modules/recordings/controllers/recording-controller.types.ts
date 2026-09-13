import type { WebsiteQuery } from "../../websites/interfaces";
import type { RecordingMutations, RecordingQuery } from "../interfaces";

export type RecordingControllerDeps = {
  recordingList: Pick<RecordingQuery, "listSessions">;
  recordingDetails: Pick<RecordingQuery, "getSessionDetail">;
  recordingDeletion: RecordingMutations;
  websites: WebsiteQuery;
};
