/**
 * Thin job payload: the video id only. The consumer reloads current state
 * from the database, so a redelivered or delayed job can never act on a
 * stale snapshot.
 */
export interface ProcessVideoJobData {
  videoId: string;
}
