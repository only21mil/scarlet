import { LOCAL_MEDIA_INPUT } from "@scarlet/render";
import type { DialogueVoiceRoles, Transcript } from "@scarlet/timeline";
import { ffmpeg, ffmpegPosition, FFPROBE, run } from "../render/ffmpeg.js";

const rate = 8000;
const block = 160; // 20 ms
type Energy = [number, number, number];

export function measureSources(pcm: Buffer) {
  const energy: Energy[] = [];
  const residual = [0, 0, 0], total = [0, 0, 0], solo = [0, 0, 0];
  const samples = Math.floor(pcm.length / 6);
  for (let start = 0; start < samples; start += block) {
    const powers: Energy = [0, 0, 0];
    const stop = Math.min(start + block, samples);
    for (let i = start; i < stop; i++) {
      const a = pcm.readInt16LE(i * 6), b = pcm.readInt16LE(i * 6 + 2), c = pcm.readInt16LE(i * 6 + 4);
      powers[0] += a * a; powers[1] += b * b; powers[2] += c * c;
      residual[0]! += (a - b - c) ** 2; residual[1]! += (b - a - c) ** 2; residual[2]! += (c - a - b) ** 2;
    }
    for (const k of [0, 1, 2] as const) { total[k]! += powers[k]; powers[k] /= stop - start; }
    energy.push(powers);
  }
  const mix = residual.findIndex((r, i) => total[i]! > 0 && r < .015 * total[i]!);
  if (mix >= 0) {
    const [a, b] = [0, 1, 2].filter(i => i !== mix) as [number, number];
    for (const p of energy) {
      if (p[a]! > 10000 && p[a]! > 16 * p[b]!) solo[a]!++;
      if (p[b]! > 10000 && p[b]! > 16 * p[a]!) solo[b]!++;
    }
    if (solo[a]! >= 10 && solo[b]! >= 10) return { energy, mix };
  }
  return { energy, mix: undefined };
}

export function wordSource(energy: Energy[], origin: number, mix: number, start: number, end: number) {
  if (start < origin || end <= start || end > origin + energy.length * .02 + .001) return;
  const [a, b] = [0, 1, 2].filter(i => i !== mix) as [number, number];
  let aOnly = 0, bOnly = 0, both = 0;
  for (let i = Math.max(0, Math.floor((start - origin) / .02)); i < Math.ceil((end - origin) / .02); i++) {
    const p = energy[i];
    if (!p || Math.max(p[a]!, p[b]!) < 100000) continue;
    if (p[a]! > 16 * p[b]!) aOnly++;
    else if (p[b]! > 16 * p[a]!) bOnly++;
    else both++;
  }
  const voiced = aOnly + bOnly + both;
  if (voiced >= Math.max(3, Math.ceil(Math.min(end - start, .5) * 12)) && Math.max(aOnly, bOnly) / voiced >= .85) return aOnly > bOnly ? a : b;
}

export function savedVoiceLabels(transcript: Transcript, roles?: DialogueVoiceRoles): Transcript {
  if (!roles) return transcript;
  return { ...transcript, segments: transcript.segments.map(s => ({ ...s, words: s.words.map(w => {
    if (w.voiceRoleInput === undefined) return w;
    const role = w.voiceRoleInput === roles.me ? "me" : w.voiceRoleInput === roles.other ? "other voices" : undefined;
    return { ...w, speaker: role === "other voices" && w.detectedSpeaker ? `other voices · Speaker ${w.detectedSpeaker}` : role, audioSource: role };
  }) })) };
}

export async function sourceLabels(file: string, signal: AbortSignal) {
  const raw = await run(FFPROBE, ["-v", "error", ...LOCAL_MEDIA_INPUT, "-select_streams", "a", "-show_entries",
    "stream=start_time:stream_tags=title", "-of", "json", file], { signal: signal });
  const tracks: { start_time?: string; tags?: { title?: string } }[] = JSON.parse(raw.toString()).streams ?? [];
  if (tracks.length !== 3 || tracks.some(t => Math.abs(Number(t.start_time ?? 0)) > .02)) return [];
  return tracks.map((t, i) => t.tags?.title?.trim().slice(0, 40) || `Track ${i + 1}`);
}

export async function readSourceEnergy(file: string, from: number, to: number, signal: AbortSignal) {
  const filter = [0, 1, 2].map(i => `[0:a:${i}]aresample=${rate},aformat=channel_layouts=mono[a${i}]`).join(";") +
    ";[a0][a1][a2]join=inputs=3:channel_layout=3.0:map=0.0-FL|1.0-FR|2.0-FC[out]";
  const pcm = await ffmpeg(["-ss", ffmpegPosition(from), ...LOCAL_MEDIA_INPUT, "-i", file, "-t", String(to - from),
    "-filter_complex", filter, "-map", "[out]", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"], { signal });
  return measureSources(pcm);
}
