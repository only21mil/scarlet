import { describe, expect, it } from "vitest";
import { keptEditsNote } from "./editor-kept.js";

describe("telling a run which flagged edits the editor kept", () => {
  const hold = { changeId: "chg_round4", spot: 2, label: "Kept the cube solve animation", check: "The cube animates for 2.1 seconds before Matt speaks.",
    at: "2026-11-16T22:25:32Z", place: { version: "v16", range: { start: 830.77, end: 832.83 } } };

  it("names each one once, with where it was and what the run flagged", () => {
    const heard = new Set<string>();
    const note = keptEditsNote([hold, { changeId: "chg_round4", spot: 0, label: "Tightened joins", at: "2026-11-16T22:26:00Z" }], heard);
    expect(note).toBe("The editor kept this flagged edit after reading your reason to look, which settles it. When you save or list the edit again, " +
      "leave its check off, unless you change the edit or find a different problem there:\n" +
      "- “Kept the cube solve animation” (chg_round4, edit 2) at 830.8–832.8 s on version v16. You flagged: “The cube animates for 2.1 seconds before Matt speaks”.");
    expect(keptEditsNote([hold], heard)).toBeUndefined();
  });

  it("says nothing of an edit kept that the run never flagged", () => {
    expect(keptEditsNote([{ changeId: "c", spot: 0, label: "Cut", at: "2026-11-16T22:26:00Z" }], new Set())).toBeUndefined();
  });
});
