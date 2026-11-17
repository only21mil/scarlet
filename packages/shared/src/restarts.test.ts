import { describe, expect, it } from "vitest";
import { findRestarts } from "./restarts.js";

const said = (text: string, gaps: Record<number, number> = {}) => {
  const tokens = text.toLowerCase().replace(/[^a-z0-9' ]/g, "").split(/\s+/);
  let t = 0;
  const starts: number[] = [], ends: number[] = [];
  tokens.forEach((_, i) => { t += gaps[i] ?? 0; starts.push(t); t += .3; ends.push(t); });
  return { tokens, found: findRestarts(tokens, starts, ends) };
};
const phrases = (r: ReturnType<typeof said>) => r.found.map(f => [r.tokens.slice(f.at, f.at + f.length).join(" "), r.tokens.slice(f.at + f.length, f.next).join(" ")]);

describe("restarts", () => {
  it("finds a phrase that comes back after an abandoned continuation, and an immediate retake", () => {
    expect(phrases(said("the water is gorgeous there's this like white I don't know what that is there's this like white stuff around the rocks")))
      .toEqual([["there's this like white", "i don't know what that is"]]);
    expect(phrases(said("very fast and in fact you can load it locally and in fact you can load it locally if you have a gpu")))
      .toEqual([["and in fact you can load it locally", ""]]);
    // One word slipped into the second saying: the words after it still come back.
    expect(phrases(said("a model that just outputs something so that outputs something so wild"))).toEqual([["outputs something so", "that"]]);
  });

  it("pairs a third saying with the second, and takes the longest phrase a word starts", () => {
    const r = said("so I asked it so I asked it so I asked it now estimate");
    expect(r.found).toEqual([{ at: 0, length: 4, next: 4 }, { at: 4, length: 4, next: 8 }]);
  });

  it("leaves ordinary speech alone: two shared words apart, one word doubled, a phrase said again much later", () => {
    expect(said("you can draw on it and you can have different colors").found).toEqual([]);
    expect(said("it is very very fast").found).toEqual([]);
    // Thirteen words between, and then thirty seconds between.
    expect(said("we have the test here one two three four five six seven eight nine ten eleven twelve thirteen we have the test again").found).toEqual([]);
    expect(said("here is the plate okay here is the plate", { 5: 30 }).found).toEqual([]);
  });

  it("takes two words only when at most one word comes between", () => {
    expect(phrases(said("and I do not want and I do not need it"))).toEqual([["and i do not", "want"]]);
    expect(phrases(said("blue orange uh blue orange then green"))).toEqual([["blue orange", "uh"]]);
    expect(said("blue orange and then blue orange").found).toEqual([]);
  });
});
