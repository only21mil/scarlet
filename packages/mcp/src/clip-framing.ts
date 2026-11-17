import { clipEnd, Transform as TransformSchema, type MediaAsset, type MediaClip, type Timeline, type Transform, type TransformKeyframe } from "@scarlet/timeline";
import { pictureBox, type Box } from "./framing.js";

/** A clip an edit added that plays its recording full frame, beside a clip of the same recording that is framed. */
export interface UnframedClip {
  clipId: string;
  trackId: string;
  /** Where the added clip starts, in seconds on the edited timeline. */
  at: number;
  /** The framed clip beside it on the same track, and its framing. */
  beside: { clipId: string; transform?: Transform; keyframes?: TransformKeyframe[] };
}

const framed = (clip: MediaClip) => !!clip.transform || !!clip.keyframes?.length;

/**
 * Footage an edit puts back or copies arrives as new clips, which play their recording full frame unless the edit
 * frames them. Beside clips of the same recording that are zoomed or inset, that shows as a jump: a speed-up put a
 * 16 s wait back with the camera filling the frame and the screen unzoomed, between clips with the camera in the corner
 * (2026-11-15), and a cold open's first draft did the same. The agent reads this as evidence; whether the new clip
 * should match is its call.
 */
export function unframedBeside(before: Timeline | null, after: Timeline): UnframedClip[] {
  const existing = new Set(before?.tracks.flatMap(t => t.clips.map(c => c.id)) ?? []);
  const found: UnframedClip[] = [];
  for (const track of after.tracks) {
    if (track.kind !== "video") continue;
    const clips = track.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false)
      .sort((a, b) => a.timelineIn - b.timelineIn);
    clips.forEach((clip, i) => {
      if (existing.has(clip.id) || framed(clip)) return;
      const near = [clips[i - 1], clips[i + 1]].find(c => c && c.mediaId === clip.mediaId && framed(c));
      if (!near) return;
      found.push({ clipId: clip.id, trackId: track.id, at: Math.round(clip.timelineIn * 1000) / 1000,
        beside: { clipId: near.id, ...(near.transform && { transform: near.transform }), ...(near.keyframes?.length && { keyframes: near.keyframes }) } });
    });
  }
  return found;
}

export const UNFRAMED_NEXT = "Each clip in unframedBeside was added by this edit and plays its recording full frame, while the clip beside it on its track, from the same recording, is framed as shown. If it should look the same, give it that transform (and keyframes) with updateClip.";

/** A stretch of the edit where this edit's framing leaves the timeline's background showing. */
export interface BackgroundShown {
  /** Timeline seconds, over the clips in a row that leave the same share showing. */
  from: number; to: number;
  /** The first of those clips, and how many there are. */
  clipId: string; clips: number;
  /** The share of the video that no picture covers there. */
  share: number;
}

/** The area a set of boxes covers together, inside the unit square. */
function covered(boxes: readonly Box[]) {
  const xs = [...new Set(boxes.flatMap(b => [b[0], b[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(boxes.flatMap(b => [b[1], b[3]]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    const x = (xs[i]! + xs[i + 1]!) / 2, y = (ys[j]! + ys[j + 1]!) / 2;
    if (boxes.some(b => x > b[0] && x < b[2] && y > b[1] && y < b[3])) total += (xs[i + 1]! - xs[i]!) * (ys[j + 1]! - ys[j]!);
  }
  return total;
}

/**
 * Where the pictures an edit framed leave part of the video uncovered, so the timeline's background shows there. A
 * crop to an area that isn't the canvas's shape does it: a pass framed its screen demos that way and filled 49–80% of
 * the frame's width, and nothing it read back said so (2026-11-16). Read from each clip the edit added or framed, at
 * its first frame, with every opaque picture playing there. Whether the background should show is the agent's call.
 */
export function backgroundShows(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number }): BackgroundShown[] {
  const was = new Map(before?.tracks.flatMap(t => t.clips.map(c => [c.id, c] as const)) ?? []);
  const assets = new Map(media.map(m => [m.id, m]));
  const opaque = (c: MediaClip) => c.enabled !== false && c.opacity > 0 && !!assets.get(c.mediaId) && assets.get(c.mediaId)!.kind !== "graphic" && !assets.get(c.mediaId)!.hasAlpha;
  const tracks = after.tracks.filter(track => track.kind === "video" && !track.hidden)
    .map(track => track.clips.filter((c): c is MediaClip => c.kind === "media" && opaque(c)).sort((a, b) => a.timelineIn - b.timelineIn));
  const layers = tracks.flat();
  const size = (clip: MediaClip) => ({ width: assets.get(clip.mediaId)!.width || canvas.width, height: assets.get(clip.mediaId)!.height || canvas.height });
  // A saved clip carries its transform's defaults and one read back may not: the framing is what is compared.
  const framing = (clip: MediaClip) => JSON.stringify([TransformSchema.parse(clip.transform ?? {}), (clip.keyframes ?? []).map(k => [k.time, k.transform, k.ease ?? "linear"])]);
  const found: BackgroundShown[] = [];
  for (const clips of tracks) {
    let last: BackgroundShown | undefined;
    for (const clip of clips) {
      const old = was.get(clip.id);
      if (!framed(clip) || (old?.kind === "media" && framing(old) === framing(clip))) continue;
      const at = clip.timelineIn + Math.min(0.05, (clipEnd(clip) - clip.timelineIn) / 2);
      const playing = layers.filter(l => l.timelineIn <= at && at < clipEnd(l));
      if (playing.some(l => l.transform?.rotation)) continue;
      const boxes = playing.map(l => pictureBox(l, at - l.timelineIn, size(l), canvas))
        .map(([l, t, r, b]): Box => [Math.max(0, l), Math.max(0, t), Math.min(1, r), Math.min(1, b)]).filter(b => b[2] > b[0] && b[3] > b[1]);
      const share = Math.round((1 - covered(boxes)) * 100) / 100;
      if (share < 0.02) continue;
      if (last && last.share === share && Math.abs(last.to - clip.timelineIn) < 0.05) { last.to = Math.round(clipEnd(clip) * 1000) / 1000; last.clips++; }
      else found.push(last = { from: Math.round(clip.timelineIn * 1000) / 1000, to: Math.round(clipEnd(clip) * 1000) / 1000, clipId: clip.id, clips: 1, share });
    }
  }
  found.sort((a, b) => a.from - b.from);
  return found.slice(0, 20);
}

export const BACKGROUND_NEXT = "Each stretch in backgroundShows plays with that share of the video uncovered by any picture, so the timeline's background shows there: a crop that isn't the video's shape leaves it at the sides. If the picture should fill the video, timeline_framing frames it on an area with none showing.";
