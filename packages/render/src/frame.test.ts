import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveFfmpeg, runCapture } from "./exec.js";
import { extractFrame, percentGrid } from "./frame.js";

/** A JPEG's pixels as RGB, with its size read from how many there are at the width asked for. */
async function pixels(jpeg: Buffer, width: number) {
  const { stdout } = await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdin: jpeg });
  const height = stdout.length / 3 / width;
  return { height, at: (x: number, y: number) => [...stdout.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)] };
}

it("labels lines at round percents of the whole picture, closer together over a smaller area", () => {
  const labels = (filters: string[]) => filters.flatMap(f => /text='([^']+)'/.exec(f)?.[1] ?? []);
  const whole = percentGrid([0, 0, 1, 1], 1920, 1080);
  expect(labels(whole)).toEqual(["10", "20", "30", "40", "50", "60", "70", "80", "90", "10", "20", "30", "40", "50", "60", "70", "80", "90"]);
  expect(whole.find(f => f.startsWith("drawbox=x=960:"))).toBeDefined();
  // A fifth of the picture across: lines every 5 percent, placed where those percents fall in the area.
  const part = percentGrid([0.4, 0.2, 0.6, 0.5], 1000, 844);
  expect(labels(part).slice(0, 3)).toEqual(["45", "50", "55"]);
  expect(part.find(f => f.startsWith("drawbox=x=500:"))).toBeDefined();
  expect(labels(part).slice(3)).toEqual(["25", "30", "35", "40", "45"]);
});

it("draws one area of a frame at the width asked for, with the grid over it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-frame-"));
  try {
    const file = join(dir, "halves.mp4");
    // Red on the left half, blue on the right.
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=1,drawbox=x=320:y=0:w=320:h=360:color=blue:t=fill",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", file]);
    const right = await pixels(await extractFrame(file, 0.5, { width: 320, area: [0.5, 0, 1, 1] }), 320);
    expect(right.height).toBe(360);
    const [r, , b] = right.at(20, 180);
    expect(b! - r!).toBeGreaterThan(100);
    const gridded = await pixels(await extractFrame(file, 0.5, { width: 640, grid: { width: 640, height: 360 } }), 640);
    expect(gridded.height).toBe(360);
    // The 30 percent line is lighter than the red beside it.
    expect(gridded.at(192, 300)[1]!).toBeGreaterThan(gridded.at(180, 300)[1]! + 40);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
