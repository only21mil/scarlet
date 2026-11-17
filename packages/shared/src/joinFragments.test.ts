import { describe, expect, it } from "vitest";
import { closesSentence, joinFragment, joinsPlacedByCuts, versionJoins, type SaidWord } from "./joinFragments.js";

/**
 * A join written as it reads: the words in [brackets] are the ones it took out. Each word lasts a third of a second,
 * and `/` ends a transcript segment where the punctuation doesn't end the sentence.
 */
function join(reading: string) {
  const words: SaidWord[] = [];
  let out = 0, inn = 0;
  for (const raw of reading.split(/\s+/)) {
    const opens = raw.startsWith("["), closes = raw.endsWith("]") || raw.endsWith("]/");
    const segmentEnd = raw.endsWith("/");
    const text = raw.replace(/^\[/, "").replace(/\/$/, "").replace(/\]$/, "");
    const start = words.length * .4;
    if (opens) out = start - .05;
    words.push({ text, start, end: start + .3, endsSentence: segmentEnd || closesSentence(text) });
    if (closes) inn = start + .35;
  }
  return joinFragment(words, out, inn);
}

describe("joinFragment", () => {
  it("gives the words either side of a join that left a stray word of the sentence it cut", () => {
    // The first word of a restart stayed in front of the next sentence.
    expect(join("in this chat window. Do not use tools. Do [do not use tools. Now, not use tools.] Now the reason that I do that"))
      .toMatchObject({ before: "in this chat window. Do not use tools. Do", after: "Now the reason that I do that", removed: 8,
        removedStart: "do not use tools. Now, not use tools.", removedEnd: "", split: ["out"] });
    expect(join("beating every single other model out there. I [mean, this is super impressive. And then it is the best bang for your buck.] This model is the best bang"))
      .toMatchObject({ split: ["out"], before: expect.stringMatching(/out there\. I$/), after: expect.stringMatching(/^This model is/) });
    // A word of the talk that was cut stayed at the head of the next piece: the sentence it belongs to is gone.
    expect(join("we can look at the back i [kind of wish that it had the thing that charges the watch] the one thing i don't see here"))
      .toMatchObject({ split: ["out", "in"], removed: 12 });
  });

  it("gives a sentence cut off before its end, and one that lost the clause it began with", () => {
    expect(join("it kind of highlights and centers it and it gives me more [damn it's going crazy/ I just want it to finish, um,] okay so the hairspring is a flat spiral"))
      .toMatchObject({ split: ["out", "in"], before: expect.stringMatching(/gives me more$/), after: expect.stringMatching(/^okay so the hairspring/) });
    expect(join("very different from what I'm used to with these tests, but [give me a detailed prompt and have, and then I will basically,] and then I'll copy paste the prompt"))
      .toMatchObject({ split: ["out", "in"] });
    // The sentence before ended whole. What plays next finishes a sentence whose start was cut.
    expect(join("Butter croissants, eight, cream-filled horn croissants, nine. [So not only was it able to count every pastry, but it was] actually able to name them all,"))
      .toMatchObject({ split: ["in"], removed: 13, removedStart: "So not only was it able to count every pastry,", removedEnd: "but it was",
        before: "Butter croissants, eight, cream-filled horn croissants, nine.", after: "actually able to name them all," });
    // The verb went with the take that was cut.
    expect(join("but this is artificial analysis. You can [get this model up to 12, up to 1,286] up to 1,286 tokens per second"))
      .toMatchObject({ split: ["out", "in"], before: expect.stringMatching(/You can$/), after: expect.stringMatching(/^up to 1,286 tokens/) });
  });

  it("gives a correction that lost what it corrects, and nothing for one that kept it", () => {
    // “I ran it twice, I ran it three times”: the second saying replaces the first, and still says what was run.
    expect(join("on the full set. [I ran it twice,] I ran it three times and it held up.")).toBeUndefined();
    // Cut one phrase further, the number is all that plays.
    expect(join("on the full set. [I ran it twice, I ran it] three times and it held up."))
      .toMatchObject({ split: ["in"], before: "on the full set.", after: "three times and it held up.", removedStart: "I ran it twice, I ran it" });
    // Only the number was taken back. The join is given, with the word it replaced, for the model to read.
    expect(join("on the full set, and I ran it [twice,] three times and it held up."))
      .toMatchObject({ split: ["out", "in"], before: expect.stringMatching(/I ran it$/), after: expect.stringMatching(/^three times/), removedStart: "twice," });
  });

  it("says nothing of a pause, of whole sentences taken out, or of a saying swapped for its twin", () => {
    const pause: SaidWord[] = [{ text: "ready", start: 1, end: 1.4 }, { text: "now", start: 3, end: 3.3 }];
    expect(joinFragment(pause, 1.6, 2.8)).toBeUndefined();
    expect(join("That is the watch. [Can you move that window? Thanks.] Next is the game.")).toBeUndefined();
    // A segment's end is a sentence's end where the transcript has no punctuation.
    expect(join("and it looks great/ [can you move that window]/ all right the next thing")).toBeUndefined();
    // The restart's first words play, its second saying of them is removed, and the sentence runs on as it was said.
    expect(join("the new model from [DeepSeek, uh, the new model from] DeepSeek flew under the radar")).toBeUndefined();
    // One shared word is no twin: the leftover clause still needs the lead-in that was cut.
    expect(join("you should be using this model. [And one of my favorite metrics is cost per task, which counts the tokens too,] and so you want the lowest cost"))
      .toMatchObject({ split: ["in"] });
  });

  it("gives only the words the two pieces play, and where they are in the transcript", () => {
    const words: SaidWord[] = "one two three. Four five [six seven] eight nine ten.".split(" ").map((raw, i) => {
      const text = raw.replace(/[[\]]/g, "");
      return { text, start: i * .4, end: i * .4 + .3, endsSentence: closesSentence(text) };
    });
    // The piece before the join starts at “Four”; the one after ends with “nine”.
    const found = joinFragment(words, 5 * .4 - .05, 6 * .4 + .35, 3 * .4 - .05, 8 * .4 + .35);
    expect(found).toMatchObject({ before: "Four five", after: "eight nine", removedStart: "six seven", lastWord: 4, firstWord: 7, split: ["out", "in"] });
  });
});

describe("joinsPlacedByCuts", () => {
  /** A version as pieces of one recording laid end to end on a track, each [from, to] in the recording. */
  const version = (...pieces: Array<[number, number]>) => {
    let at = 0;
    return { tracks: [{ clips: pieces.map(([sourceIn, sourceOut], i) => {
      const clip = { kind: "media", mediaId: "mic", timelineIn: at, sourceIn, sourceOut, id: String(i) };
      at += sourceOut - sourceIn;
      return clip;
    }) }] };
  };

  it("reads a version's joins, and not a split that plays straight on", () => {
    expect(versionJoins(version([0, 10], [10, 20], [25, 40]))).toEqual([{ mediaId: "mic", out: 20, in: 25 }]);
  });

  it("gives a join to the change that made it, for as long as later changes leave it where it is", () => {
    const whole = version([0, 100]);
    const cut = version([0, 20], [25, 100]);                         // the cut tool takes 20–25 out
    const rewritten = version([0, 20], [25, 50], [58, 100]);         // a saved timeline takes 50–58 out
    const faded = version([0, 20.033], [24.967, 50], [58, 100]);     // a crossfade is laid over the first join
    const moved = version([0, 19.4], [24.967, 50], [58, 100]);       // then a ripple moves that join's edge
    const history = (...versions: Array<[ReturnType<typeof version>, boolean]>) => versions.map(([v, byCutTool]) => ({ joins: versionJoins(v), byCutTool }));
    expect(joinsPlacedByCuts(history([whole, false], [cut, true]))).toEqual([{ mediaId: "mic", out: 20, in: 25 }]);
    // The rewrite's join is its own. The cut's stays the cut's through the rewrite and the crossfade.
    expect(joinsPlacedByCuts(history([whole, false], [cut, true], [rewritten, false], [faded, false]))).toEqual([{ mediaId: "mic", out: 20.033, in: 24.967 }]);
    // Moved by more than a crossfade, it is the join of the change that moved it.
    expect(joinsPlacedByCuts(history([whole, false], [cut, true], [rewritten, false], [faded, false], [moved, false]))).toEqual([]);
    // A video built in one save has no join the cut tool placed.
    expect(joinsPlacedByCuts(history([rewritten, false]))).toEqual([]);
  });
});
