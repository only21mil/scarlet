// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { Timeline } from "@scarlet/timeline";
import { api } from "./client";
import { readTimeline } from "./timelineCache";

afterEach(() => vi.restoreAllMocks());

const saved = (version: string) => ({ timeline: { version } as Timeline });

it("reads a saved version once for everything that shows it, and the newest used stay", async () => {
  const read = vi.spyOn(api, "timeline").mockImplementation(async (_project, version) => saved(version!));
  // Two readers at once share one read, and a later one reuses what it read.
  const [a, b] = await Promise.all([readTimeline("prj", "v_1"), readTimeline("prj", "v_1")]);
  expect(a).toBe(b);
  expect(await readTimeline("prj", "v_1")).toBe(a);
  expect(read).toHaveBeenCalledTimes(1);
  // Another project's version of the same name is its own.
  await readTimeline("prj_2", "v_1");
  expect(read).toHaveBeenCalledTimes(2);
  // Sixteen are kept. Using v_1 again keeps it among them while the oldest others go.
  for (let i = 2; i <= 16; i++) await readTimeline("prj", `v_${i}`);
  await readTimeline("prj", "v_1");
  await readTimeline("prj", "v_17");
  read.mockClear();
  await readTimeline("prj", "v_1");
  expect(read).not.toHaveBeenCalled();
  await readTimeline("prj_2", "v_1");
  expect(read).toHaveBeenCalledOnce();
  // The working cut by name isn't a saved version: it is read each time.
  await readTimeline("prj", "head");
  await readTimeline("prj", "head");
  expect(read).toHaveBeenCalledTimes(3);
});

it("asks again for a version whose read failed, and lets one waiter go without dropping the read", async () => {
  let answer!: (value: { timeline: Timeline }) => void;
  const read = vi.spyOn(api, "timeline").mockRejectedValueOnce(new Error("engine away"))
    .mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  await expect(readTimeline("prj", "v_gone")).rejects.toThrow("engine away");
  const stop = new AbortController();
  const left = readTimeline("prj", "v_gone", stop.signal);
  const stays = readTimeline("prj", "v_gone");
  stop.abort(new Error("moved on"));
  await expect(left).rejects.toThrow("moved on");
  answer(saved("v_gone"));
  expect(await stays).toEqual({ version: "v_gone" });
  expect(read).toHaveBeenCalledTimes(2);
});
