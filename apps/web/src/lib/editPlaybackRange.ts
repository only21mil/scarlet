import type { TimeRange } from "@scarlet/timeline";

const MIN_EDIT_PREVIEW_SECONDS = 3;

/** Play enough surrounding footage to make a brief edit perceptible. */
export function editPlaybackRange(range: TimeRange, duration: number): TimeRange {
  const context = (MIN_EDIT_PREVIEW_SECONDS - (range.end - range.start)) / 2;
  if (context <= 0 || duration <= 0) return range;
  const start = Math.max(0, Math.min(range.start - context, duration - MIN_EDIT_PREVIEW_SECONDS));
  return { start, end: Math.min(duration, start + MIN_EDIT_PREVIEW_SECONDS) };
}
