import { stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { fileInDirectory } from "@scarlet/render";
import type { MediaAsset, Transcript } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { clip, throttledLog } from "../logText.js";
import { AnalysisCache } from "./analysisCache.js";
import { readSourceEnergy, sourceLabels, wordSource, type measureSources } from "./transcriptSources.js";

type Measured = ReturnType<typeof measureSources>;
/** Windows of levels decoded at once, each one FFmpeg on one core. */
export const ENERGY_READS = Math.max(2, Math.min(4, Math.floor(availableParallelism() / 4)));
const energyReaders = new WeakMap<Ctx, ReturnType<typeof makeEnergyReader>>();

/**
 * One reader per engine of a recording's input labels and of its inputs' levels over a window, shared by everything
 * that reads them: transcript pages, the input the dialogue is on, scan pages and the editor's voice reference. Each
 * kept its own cache, or none, so the same window was decoded again by each. A window is the one asked for, decoded
 * as `readSourceEnergy` decodes it, so what each reader says is unchanged. `signal` stops this caller's wait, and the
 * decode once nobody waits for it.
 */
export function sourceEnergyReader(ctx: Ctx) {
  let reader = energyReaders.get(ctx);
  if (!reader) energyReaders.set(ctx, reader = makeEnergyReader());
  return reader;
}

function makeEnergyReader() {
  const streams = new AnalysisCache<string[]>(r => r.length * 100, 64 * 1024);
  const windows = new AnalysisCache<Measured>(r => r.energy.length * 64, 32 * 1024 * 1024, ENERGY_READS);
  const stamp = async (file: string) => {
    const info = await stat(file);
    return JSON.stringify([file, info.size, info.ctimeMs, info.mtimeMs]);
  };
  return {
    async labels(file: string, signal: AbortSignal) {
      return streams.get(await stamp(file), work => sourceLabels(file, work), { signal });
    },
    async energy(file: string, from: number, to: number, signal: AbortSignal) {
      return windows.get(JSON.stringify([await stamp(file), from, to]), work => readSourceEnergy(file, from, to, work), { signal });
    },
  };
}

/** Read-only annotation for short transcript pages. A verified mix must equal
 * the two independent inputs, including passages where each input plays alone.
 * A page is read because someone asked for it, a running edit among them, so a pause of the project's media work
 * doesn't stop the read. Trash and a quit do. */
export function transcriptSourceReader(ctx: Ctx) {
  const reader = sourceEnergyReader(ctx);
  const layouts = new Map<string, number>();
  // Asked for with each page of a transcript, so a recording that can't be read is logged once a minute.
  const failed = throttledLog(line => ctx.log(line));
  return async (projectId: string, media: MediaAsset, transcript: Transcript, from: number, to: number) => {
    const end = Math.min(to, media.duration ?? to);
    if (from < 0 || end <= from || end - from > 60.001 || !transcript.segments.length) return transcript;
    try {
      const file = fileInDirectory(ctx.paths.media(projectId), media.path);
      if (!file) return transcript;
      const info = await stat(file);
      const key = JSON.stringify([file, info.size, info.ctimeMs, info.mtimeMs]);
      const labels = await reader.labels(file, ctx.projectSignal(projectId));
      if (!labels.length) return transcript;
      const result = await reader.energy(file, from, end, ctx.projectSignal(projectId));
      if (result.mix !== undefined) {
        if (layouts.size >= 64 && !layouts.has(key)) layouts.delete(layouts.keys().next().value!);
        layouts.set(key, result.mix);
      }
      const roles = media.voiceRoles;
      const confirmedMix = roles && 3 - (roles.me - 1) - (roles.other - 1);
      const mix = result.mix ?? layouts.get(key) ?? confirmedMix;
      if (mix === undefined) return transcript;
      return { ...transcript, segments: transcript.segments.map(s => ({ ...s, words: s.words.map(w => {
        const input = wordSource(result.energy, from, mix, w.start, w.end);
        return input === undefined ? w : { ...w, audioSource: mix === confirmedMix && input + 1 === roles?.me ? "me" : mix === confirmedMix && input + 1 === roles?.other ? "other voices" : labels[input] };
      }) })) };
    } catch (error) {
      if (!ctx.projectSignal(projectId).aborted) {
        failed(media.id, `[media] ${media.id} couldn’t tell which input each word came from: ${clip((error as Error).message, 300)}`);
      }
      return transcript;
    }
  };
}
