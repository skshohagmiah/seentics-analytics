import type { RecordingRawReads } from "../interfaces";
import { listReplaySessionsRaw } from "./recording-session-list.service";

/** `RecordingRawReads` over this module's existing session-list function. */
export class RecordingRawReadService implements RecordingRawReads {
  listSessionsRaw(
    websiteId: string,
    limit: number,
    offset: number,
  ): ReturnType<RecordingRawReads["listSessionsRaw"]> {
    return listReplaySessionsRaw(websiteId, limit, offset);
  }
}
