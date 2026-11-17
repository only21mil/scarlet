import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProject, makeMediaClip, makeTrack, timelineFromKeepRanges } from "@scarlet/timeline";
import { createApp } from "../app.js";
import { accessToken } from "../auth.js";
import { WhisperCppProvider } from "../transcribe/whispercpp.js";
import { UhmDetector } from "../transcribe/uhm.js";
import { measuredLoudness } from "../render/loudness.js";
import { cancelTask, createTask } from "./tasks.js";
import { storeVersion } from "./timeline.js";
import { passRecordings, prefetchDialoguePass } from "./dialoguePrefetch.js";

vi.mock("@scarlet/render", async original => ({
  ...await original<typeof import("@scarlet/render")>(),
  speechActivityOf: async () => [],
}));
vi.mock("../transcribe/wordAlign.js", async original => ({ ...await original<typeof import("../transcribe/wordAlign.js")>(), alignWords: async (_ctx: unknown, _wav: string, segments: unknown) => segments }));
vi.mock("../render/ffmpeg.js", async original => ({
  ...await original<typeof import("../render/ffmpeg.js")>(),
  extractWav: async (_file: string, target: string) => {
    const emptyWav = Buffer.alloc(20);
    emptyWav.write("data", 12);
    await writeFile(target, emptyWav);
  },
}));
vi.mock("../render/loudness.js", () => ({ measuredLoudness: vi.fn(async () => ({ integratedLufs: -20, loudnessRangeLu: 4, truePeakDbtp: -1 })) }));

it("reads a claimed first dialogue pass's recordings ahead of its first scan call, and reports them once it asks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-dialogue-prefetch-"));
  const app = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  let release: (() => void) | undefined;
  try {
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Read ahead"));
    ctx.paths.ensureProject(project.id);
    const put = (id: string, kind: "audio" | "video", words: boolean) => {
      const media = ctx.repos.projects.putMedia(project.id, { id, name: id, kind, path: `${id}.wav`, duration: 180, hasAudio: true }, "ready");
      ctx.repos.transcripts.put({ id: `trs_${id}`, projectId: project.id, mediaId: id,
        segments: words ? [{ id: "s", start: 1, end: 2, text: "hello", words: [{ text: "hello", start: 1, end: 2 }] }] : [] });
      return ctx.repos.projects.putMedia(project.id, { ...media, transcriptId: `trs_${id}` }, "ready");
    };
    const mic = put("mic", "audio", true);
    put("cam", "video", true);
    put("music", "audio", false);
    for (const id of ["mic", "cam", "music"]) await writeFile(join(ctx.paths.media(project.id), `${id}.wav`), id);
    // The camera's picture plays with its sound off, the mic carries the dialogue, and a music bed plays under it.
    const timeline = timelineFromKeepRanges(project.id, "cam", [{ start: 0, end: 180 }], { audioMediaId: "mic" });
    const bed = makeTrack("audio", "Music");
    bed.clips.push(makeMediaClip("music", 0, 180, 0));
    timeline.tracks.push(bed);
    const version = storeVersion(ctx, project.id, timeline, { parent: null });
    ctx.repos.projects.update(project.id, { head: version.version });
    expect(passRecordings(ctx, project.id).map(m => m.id)).toEqual(["mic"]);

    ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
    vi.spyOn(ctx.speakers, "turns").mockResolvedValue([]);
    vi.spyOn(UhmDetector.prototype, "detect").mockResolvedValue([]);
    const result = { language: "en", segments: [] };
    const whisper = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockResolvedValue(result);
    const gate = new Promise<void>(resolve => { release = resolve; });
    // The second page is still being read when the pass asks.
    whisper.mockImplementationOnce(async () => result).mockImplementationOnce(async () => { await gate; return result; });
    const create = (context = {}) => createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "First cut",
      state: "running", context: { dialogueOperation: "first-cut", ...context }, createdBy: { type: "scarlet", name: "Scarlet" } });

    // A request about one cut, or one that isn't a dialogue pass, reads nothing ahead.
    for (const other of [create({ cutIndex: 0, changeId: "chg_x" }), create({ dialogueOperation: "none" })]) {
      prefetchDialoguePass(ctx, other);
      cancelTask(ctx, other);
    }
    expect(whisper).not.toHaveBeenCalled();
    expect(measuredLoudness).not.toHaveBeenCalled();

    const task = create();
    prefetchDialoguePass(ctx, task);
    // The loudness media_profile reads is measured under the key the loudness route uses.
    await vi.waitFor(() => expect(measuredLoudness).toHaveBeenCalledTimes(1));
    expect(vi.mocked(measuredLoudness).mock.calls[0]![1]).toBe(await realpath(join(ctx.paths.media(project.id), "mic.wav")));
    await vi.waitFor(() => expect(whisper).toHaveBeenCalledTimes(2));
    const events = () => ctx.repos.taskEvents.list(task.id).flatMap(e => e.data?.scanPage ? [e.data.scanPage] : []);
    // Nothing is reported read until the pass asks for the recording.
    expect(events()).toEqual([]);
    const scan = await app.app.request(`/api/projects/${project.id}/dialogue-scan`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, mediaId: mic.id, from: 0, to: 180 }),
    });
    expect(await scan.json()).toEqual([{ start: 0, end: 60 }]);
    // The pass's call joined the scan under way: the page read before it asked is reported now, and the rest as read.
    expect(events()).toEqual([{ mediaId: "mic", from: 0, to: 60, end: 180 }]);
    release!();
    await vi.waitFor(() => expect(events()).toHaveLength(4));
    expect(whisper).toHaveBeenCalledTimes(4);
    expect(events().map(page => page.from)).toEqual([0, 58, 116, 174]);
    cancelTask(ctx, task);
    await Promise.all([...ctx.pending]);

    // A pass that reads the recording from somewhere else: the read-ahead stops after the page it is on.
    ctx.db.prepare("DELETE FROM dialogue_scan_pages").run();
    whisper.mockClear();
    const held = new Promise<void>(resolve => { release = resolve; });
    whisper.mockImplementationOnce(async () => result).mockImplementationOnce(async () => { await held; return result; });
    const later = create();
    prefetchDialoguePass(ctx, later);
    await vi.waitFor(() => expect(whisper).toHaveBeenCalledTimes(2));
    expect((await app.app.request(`/api/projects/${project.id}/dialogue-scan`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: later.id, mediaId: mic.id, from: 30, to: 180 }),
    })).ok).toBe(true);
    release!();
    await vi.waitFor(() => expect(ctx.repos.taskEvents.list(later.id).filter(e => e.data?.scanPage?.to)).toHaveLength(3));
    await new Promise(resolve => setTimeout(resolve, 50));
    // Its two pages and the pass's three: 0–60 and 58–118, then 30–90, 88–148 and 146–180.
    expect(whisper).toHaveBeenCalledTimes(5);
    cancelTask(ctx, later);
    await Promise.all([...ctx.pending]);
  } finally {
    release?.();
    await app.ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
