import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FlagEditRequest } from "@scarlet/shared";
import { createProject, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { localUser } from "../auth.js";
import { scarletRenderAdapter } from "../render/scarletRender.js";
import { flagEdit, proposeChange } from "./changes.js";
import { createTask } from "./tasks.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-changes-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {},
    render: { ...scarletRenderAdapter, async renderFullCached(p, _tl, _cache, file) { writeFileSync(file, JSON.stringify(p.settings)); } } });
  workspace.ctx.speakers.beside = false;
  project = workspace.ctx.repos.projects.insert(createProject("Test"));
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

it("places an agent's later ripple removal on the footage it was written for, after an earlier one went onto whole frames", () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Cut the stumbles", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 60, hasAudio: true }, "ready");
  proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 60 } }] });
  // At 30 fps the first removal is frames 301 to 360: 1.9667 s of the 2.010 s asked. The second was written on the edit
  // with 2.010 s out, so the footage it meant (22.01–23.01 s) now plays from 20.0433 s, and it goes inward onto frames from there.
  const cut = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Stumbles",
    ops: [{ op: "rippleDelete", start: 10.01, end: 12.02 }, { op: "rippleDelete", start: 20, end: 21 }] });
  expect(cut.change.ops).toEqual([{ op: "rippleDelete", start: 301 / 30, end: 12 }, { op: "rippleDelete", start: 602 / 30, end: 631 / 30 }]);
  // The footage after the second removal resumes at 23.0 s of the source, inside the 22.01–23.01 s asked, not before it.
  const clips = cut.timeline.tracks.find(t => t.id === "a1")!.clips;
  expect(clips.map(c => c.kind === "media" && c.sourceIn)).toEqual([0, 12, expect.closeTo(631 / 30 + (12 - 301 / 30), 9)]);
});

it("flags an edit once for a run, also when the run was resumed as a new attempt", async () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const by = { type: "human" as const, name: "Editor" };
  const cutting = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Assemble", createdBy: by });
  const made = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: cutting.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }],
    timelineEdits: [{ label: "Open on the answer", range: { start: 0, end: 4 } }] }).change;
  expect(made.state).toBe("approved");
  const first = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Check the music", createdBy: by });
  const resumed = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Check the music", createdBy: by, resumeRootId: first.id });
  const body = { changeId: made.id, spot: 0, check: "The music swells over the answer" };
  flagEdit(ctx, project.id, first, body);
  flagEdit(ctx, project.id, resumed, body);
  expect(ctx.repos.changes.get(made.id)!.flags).toMatchObject([{ spot: 0, check: body.check, taskId: first.id }]);
  const range = { start: 12, end: 13 };
  const location = { version: made.toVersion, range };
  flagEdit(ctx, project.id, resumed, { ...body, range });
  flagEdit(ctx, project.id, resumed, { ...body, range });
  expect(ctx.repos.changes.get(made.id)!.flags).toMatchObject([{ spot: 0, check: body.check, taskId: first.id, location }]);
  // Another request that finds the same doubt flags it on its own.
  const other = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Check the mix", createdBy: by });
  flagEdit(ctx, project.id, other, body);
  expect(ctx.repos.changes.get(made.id)!.flags).toHaveLength(2);
});

it("records a flag's playback range in the version it refers to", () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const user = localUser(ctx);
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Assemble", createdBy: { type: "human", name: "Editor" } });
  const made = proposeChange(ctx, user, project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }],
    timelineEdits: [{ label: "Open on the answer", range: { start: 0, end: 4 } }] }).change;
  const moved = proposeChange(ctx, user, project.id, { intent: "requested", taskId: task.id, description: "Tighten the pause",
    ops: [{ op: "rippleDelete", start: 5, end: 7 }] }).change;
  const historical = { check: "Check the mix later in the opening", range: { start: 12, end: 12 }, version: made.toVersion };
  expect(() => flagEdit(ctx, project.id, task, historical)).toThrow(expect.objectContaining({ code: "stale_flag_range" }));
  const named = FlagEditRequest.parse({ ...historical, changeId: made.id, spot: 0 });
  const result = flagEdit(ctx, project.id, task, named);
  expect(result).toMatchObject({ flagged: { changeId: made.id, spot: 0, range: { start: 0, end: 4 } }, version: moved.toVersion });
  expect(ctx.repos.changes.get(made.id)!.flags).toMatchObject([{ location: { version: made.toVersion, range: historical.range } }]);
  expect(() => flagEdit(ctx, project.id, task, { ...named, range: { start: 21, end: 21 } }))
    .toThrow(expect.objectContaining({ code: "invalid_flag_range" }));

  const range = { start: 1, end: 2 };
  const found = flagEdit(ctx, project.id, task, FlagEditRequest.parse({ check: "Check the first line", range }));
  expect(found.flagged).toMatchObject({ changeId: made.id, spot: 0 });
  expect(ctx.repos.changes.get(made.id)!.flags?.[1]?.location).toEqual({ version: moved.toVersion, range });
  expect(FlagEditRequest.safeParse({ check: "Check the mix", changeId: made.id, spot: 0, version: made.toVersion }).success).toBe(false);
});
