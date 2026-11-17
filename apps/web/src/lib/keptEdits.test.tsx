// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startAppLog, stopAppLog } from "./appLog";
import { editKey, keepEdits, reviewKey, useKeptEdits } from "./keptEdits";
import { useReviewed } from "../components/review/ThreadEdits";
import { api } from "./client";
import type { Thread } from "@scarlet/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";

beforeEach(() => { vi.spyOn(api, "keepEdits").mockResolvedValue(undefined); });
afterEach(() => { stopAppLog(); vi.restoreAllMocks(); localStorage.clear(); });

function readKept(projectId: string, threadId: string, changes: Thread["changes"] = []) {
  let value: ReadonlySet<string> = new Set();
  const thread = { id: threadId, changes } as unknown as Thread;
  function Probe() { value = useKeptEdits(projectId, thread); return null; }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return value;
}

it("remembers kept edits per thread and notices storage changing underneath", () => {
  expect(keepEdits("prj", "thr", [{ changeId: "chg", spot: 0 }])).toBe(true);
  expect(keepEdits("prj", "thr", [{ changeId: "chg", spot: 0 }])).toBe(false);
  expect(readKept("prj", "thr").has(editKey({ changeId: "chg", spot: 0 }))).toBe(true);
  expect(readKept("prj", "other").size).toBe(0);
  localStorage.clear();
  expect(readKept("prj", "thr").size).toBe(0);
});

it("tells the engine what the editor kept, under the identity the Keep is recorded by, so the request's runs hear of it", () => {
  const send = vi.mocked(api.keepEdits);
  keepEdits("prj", "pass", [{ changeId: "round6", spot: 2, reviewRef: { changeId: "round4", spot: 2 }, label: "Held the cube solve",
    check: "The cube animates before Matt speaks.", range: { start: 830.77, end: 832.83 } }], "v9");
  expect(send).toHaveBeenCalledWith("prj", { threadId: "pass", version: "v9", edits: [{ changeId: "round4", spot: 2, label: "Held the cube solve",
    check: "The cube animates before Matt speaks.", range: { start: 830.77, end: 832.83 } }] });
  // Kept again, nothing new is sent.
  send.mockClear();
  keepEdits("prj", "pass", [{ changeId: "round6", spot: 2, reviewRef: { changeId: "round4", spot: 2 } }]);
  expect(send).not.toHaveBeenCalled();
});

it("counts a Keep the engine recorded, and sends on one this window made that the engine doesn't have", () => {
  localStorage.setItem("scarlet.kept-edits.v1/prj/older", JSON.stringify(["chg/1"]));
  const recorded = [{ id: "chg", kept: [{ spot: 0, threadId: "older", at: "2026-11-16T22:25:32Z" }, { spot: 3, threadId: "elsewhere", at: "2026-11-16T22:25:32Z" }] }];
  const kept = readKept("prj", "older", recorded as unknown as Thread["changes"]);
  expect([...kept].sort()).toEqual(["chg/0", "chg/1"]);
  expect(api.keepEdits).toHaveBeenCalledWith("prj", { threadId: "older", edits: [{ changeId: "chg", spot: 1 }] });
});

it("keeps an edit for the session when storage refuses the write, even with an older record stored", () => {
  keepEdits("prj", "full", [{ changeId: "chg", spot: 0 }]);
  const lines: string[] = [];
  startAppLog(batch => lines.push(...batch));
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("details", "QuotaExceededError"); });
  keepEdits("prj", "full", [{ changeId: "chg", spot: 1 }]);
  const kept = readKept("prj", "full");
  expect([...kept].sort()).toEqual(["chg/0", "chg/1"]);
  expect(lines).toEqual([expect.stringContaining("keep-persist-failed project=prj thread=full count=1 name=QuotaExceededError")]);
});

it("asks again about a cut the editor called once a later save gives it a new reason to look", () => {
  // The pass was applied through the editor's calls, so each of its cuts counts as reviewed.
  const thread = { id: "thr", changes: [{ id: "pass", state: "approved", appliedReview: { joins: [] } }] } as unknown as Thread;
  let reviewed!: ReturnType<typeof useReviewed>;
  function Probe() { reviewed = useReviewed("prj", thread); return null; }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  const cut = { changeId: "pass", spot: 3 };
  // A later save moved the cut's join and asked for a listen: that is its own thing to keep.
  const flagged = { ...cut, reviewRef: { changeId: "trim", spot: 0 } };
  expect(reviewed(cut)).toBe(true);
  expect(reviewed(flagged)).toBe(false);
  expect(reviewKey(flagged)).toBe("trim/0");
  act(() => { keepEdits("prj", "thr", [flagged]); });
  expect(reviewed(flagged)).toBe(true);
  act(() => root.unmount());
});

