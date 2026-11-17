import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  Clip,
  makeTimeMap,
  makeTrack,
  rebaseOp,
  RebaseConflict,
  replayOps,
  sameJson,
  stableStringify,
  timelineDuration,
  timelineFromKeepRanges,
  type Timeline,
  type TimelineOp,
} from "./index.js";

/**
 * replayOps as it was before it changed its copies in place: a copy and two serializations of the timeline per op.
 * Without footage patches or edits that add footage its checks after the loop don't apply, so the scenarios below
 * leave them out and this is the whole of it.
 */
function replayOpsBefore(base: Timeline, ops: TimelineOp[], onto: Timeline, include: (i: number) => boolean, fps: number, translatedOps: TimelineOp[]) {
  let orig = base;
  let cur = onto;
  const replay = (at: Timeline, op: TimelineOp, i: number): [Timeline, TimelineOp] => {
    const tracksSame = stableStringify(orig.tracks) === stableStringify(at.tracks);
    const same = tracksSame && stableStringify(orig.markers) === stableStringify(at.markers);
    // With the tracks different, makeTimeMap is the source map replayOps used.
    const translated = same ? op : rebaseOp(op, tracksSame ? (t => t) : makeTimeMap(orig, at, fps), at, i, fps, orig);
    try {
      return [applyOp(at, translated), translated];
    } catch (e) {
      throw new RebaseConflict(`edit ${i + 1} no longer applies: ${(e as Error).message}`, i);
    }
  };
  ops.forEach((op, i) => {
    const nextOrig = applyOp(orig, op);
    if (include(i)) {
      let translated: TimelineOp;
      [cur, translated] = replay(cur, op, i);
      translatedOps.push(translated);
    }
    orig = nextOrig;
  });
  return cur;
}

/** A seeded generator, so a failure replays. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

/** `minutes` of dialogue cut into kept passages of 5.5 s, with its sound, a caption for every three seconds and markers. */
function longCut(minutes: number): Timeline {
  const keep = Array.from({ length: minutes * 10 }, (_, i) => ({ start: i * 6, end: i * 6 + 5.5 }));
  const tl = timelineFromKeepRanges("prj", "cam", keep, { audioMediaId: "mic" });
  const captions = makeTrack("caption", "Captions", "cap");
  const duration = timelineDuration(tl);
  for (let i = 0, t = 0; t + 3 <= duration; i++, t += 3) {
    const words = Array.from({ length: 8 }, (_, k) => ({ text: `w${i}.${k}`, start: t + k * .35, end: t + k * .35 + .3 }));
    captions.clips.push(Clip.parse({ id: `cap${i}`, kind: "caption", timelineIn: t, timelineOut: t + 3, text: words.map(w => w.text).join(" "), words }));
  }
  tl.tracks.push(captions);
  for (let i = 0; i < minutes; i++) tl.markers.push({ id: `mk${i}`, time: i * 60 + 7, kind: "note", text: `Note ${i}`, resolved: false });
  return tl;
}

/**
 * `count` cuts of up to 1.5 s, each in its own 4 s of `base` before `limit` seconds, made in a random order and written
 * in sequence as a pass writes them, with caption edits and markers among them.
 */
function passOps(base: Timeline, rand: () => number, count: number, limit: number): TimelineOp[] {
  const slots = Array.from({ length: Math.floor(Math.min(limit, timelineDuration(base)) / 4) }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
  }
  const made: Array<{ at: number; length: number }> = [];
  const ops: TimelineOp[] = [];
  for (const [i, slot] of slots.slice(0, count).entries()) {
    const at = slot * 4 + .5 + rand(), length = .2 + rand() * 1.3;
    const start = at - made.reduce((sum, cut) => cut.at < at ? sum + cut.length : sum, 0);
    made.push({ at, length });
    ops.push({ op: "rippleDelete", start, end: start + length });
    if (i % 25 === 3) ops.push({ op: "updateClip", clipId: `cap${i}`, patch: { text: `Edited ${i}` } });
    if (i % 40 === 7) ops.push({ op: "addMarker", marker: { id: `pass${i}`, time: start, kind: "note", text: `Join ${i}`, resolved: false } });
    if (i % 30 === 11) ops.push({ op: "updateMarker", markerId: `mk${i % 7}`, patch: { text: `Moved ${i}` } });
  }
  return ops;
}

/** The replay's own split ids are random: name them in order so two replays compare. */
function comparable(value: unknown, known: string) {
  const names = new Map<string, string>();
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === "string" && /^clip_[0-9a-z]{12}$/.test(v) && !known.includes(v)
    ? names.get(v) ?? (names.set(v, `new${names.size}`), `new${names.size - 1}`) : v));
}

function outcome(run: () => Timeline, translated: TimelineOp[], known: string) {
  try {
    const timeline = run();
    return { timeline: comparable(timeline, known), translated: comparable(translated, known) };
  } catch (e) {
    return { error: `${(e as Error).constructor.name}: ${(e as Error).message}` };
  }
}

describe("replayOps on a long pass", () => {
  const fps = 30;
  // A 20-minute cut keeps the old replay's run short. On an hour-long one with 300 cuts it took 26 s here, and 1.5 s now.
  const base = longCut(20);
  const ops = passOps(base, random(7), 120, 1000);
  // An edit approved since, in footage the pass didn't cut: the pass's ops go through the source map.
  const head = applyOps(base, [
    { op: "rippleDelete", start: 1100, end: 1102.5 },
    { op: "rippleDelete", start: 1050, end: 1051 },
    { op: "updateMarker", markerId: "mk2", patch: { text: "Approved" } },
  ]);
  const known = JSON.stringify([base, head, ops]);
  const scenarios: Array<[string, Timeline, (i: number) => boolean]> = [
    ["every op onto its own base", base, () => true],
    ["one spot of the pass onto its own base", base, i => i % 3 === 1],
    ["every op onto a head that moved on", head, () => true],
    ["every other op onto a head that moved on", head, i => i % 2 === 0],
  ];
  for (const [name, onto, include] of scenarios) {
    it(`gives what it gave before: ${name}`, () => {
      const before = { translated: [] as TimelineOp[], ms: 0 };
      const after = { translated: [] as TimelineOp[], ms: 0 };
      const ontoBefore = stableStringify(onto), baseBefore = stableStringify(base), opsBefore = stableStringify(ops);
      let started = performance.now();
      const expected = outcome(() => replayOpsBefore(base, ops, onto, include, fps, before.translated), before.translated, known);
      before.ms = performance.now() - started;
      started = performance.now();
      const actual = outcome(() => replayOps(base, ops, onto, include, fps, after.translated), after.translated, known);
      after.ms = performance.now() - started;
      expect(actual).toEqual(expected);
      expect(actual).toHaveProperty("timeline");
      // Nothing the caller passed in changed.
      expect([stableStringify(onto), stableStringify(base), stableStringify(ops)]).toEqual([ontoBefore, baseBefore, opsBefore]);
      console.log(`replayOps, ${ops.length} ops on a 20-minute cut, ${name}: ${before.ms.toFixed(0)} ms before, ${after.ms.toFixed(0)} ms now`);
    }, 120_000);
  }

  it("hands back the caller's own timeline when no op goes in", () => {
    expect(replayOps(base, ops.slice(0, 5), head, () => false, fps)).toBe(head);
  });

  it("fails an op that doesn't apply where it was written as itself, as it did", () => {
    const bad: TimelineOp[] = [{ op: "rippleDelete", start: 1, end: 2 }, { op: "updateClip", clipId: "missing", patch: { label: "x" } }];
    const translated: TimelineOp[] = [];
    expect(outcome(() => replayOps(base, bad, head, () => true, fps), [], known))
      .toEqual(outcome(() => replayOpsBefore(base, bad, head, () => true, fps, translated), [], known));
  });
});

describe("sameJson", () => {
  it("agrees with comparing stableStringify's strings", () => {
    const values: unknown[] = [
      0, -0, 1, NaN, Infinity, null, undefined, "a", true, false, [], {}, [1, 2], [2, 1], [undefined], [null], [NaN],
      { a: 1 }, { a: 1, b: undefined }, { b: undefined }, { a: null }, { a: [1, { b: 2 }] }, { a: [1, { b: 3 }] },
      { b: 2, a: 1 }, { a: 1, b: 2 }, { a: { c: undefined } }, { a: {} }, [{}], [[]],
    ];
    for (const a of values) for (const b of values) {
      expect(sameJson(a, b), `${String(stableStringify(a))} vs ${String(stableStringify(b))}`).toBe(stableStringify(a) === stableStringify(b));
    }
  });
});
