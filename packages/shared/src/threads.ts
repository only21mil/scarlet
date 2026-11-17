/**
 * Threads: one request and everything that followed it — the agent's
 * progress, its questions, every attempt at the change, your feedback, and
 * follow-ups. The Review screen is a list of threads, like a list of agent
 * threads in a coding tool.
 *
 * Newer data carries explicit thread ids. Older data is grouped by its links:
 * a task with the changes it produced, a revision task with the change it
 * revises, a feedback note with the attempts before and after it.
 */
import { isThreadDone } from "./threadTimeline.js";
import { isAsideTask, taskRecoveryAction, type Skill, type Task } from "./api.js";
import { cutSummary, isPublishedCall, mergeRanges, rangesOverlap, type Author, type Change, type Note, type TimeRange } from "@scarlet/timeline";

export type ThreadStatus = "needs_you" | "working" | "done" | "closed";

export interface Thread {
  id: string;
  title: string;
  status: ThreadStatus;
  /** Why it needs you, when it does. */
  needs?: "question" | "decision" | "failed" | "interrupted" | "task_failed";
  tasks: Task[];
  /** Attempts, oldest first. */
  changes: Change[];
  /**
   * Other requests' applied changes with an edit this request flagged for the editor (`Change.flags`). The request
   * lists that edit with its own, as one that needs the editor.
   */
  flagged?: Change[];
  latest?: Change;
  question?: Task;
  active?: Task;
  author?: Author;
  createdAt: string;
  updatedAt: string;
}

interface Source {
  changes: Change[];
  tasks: Task[];
  notes: Note[];
}

const ACTIVE = new Set<Task["state"]>(["queued", "claimed", "running"]);
const WORKING_CHANGE = new Set<Change["state"]>(["proposed", "rendering", "revising"]);
const ts = (x?: string) => Date.parse(x ?? "") || 0;

/** Disjoint sets over task/change ids. */
class Groups {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  union(a: string, b: string) {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

export function buildThreads(d: Source): Thread[] {
  const g = new Groups();
  const tasks = d.tasks.filter((t) => t.kind !== "transcribe" && !isAsideTask(t));
  const key = (kind: "t" | "c" | "x", id: string) => `${kind}:${id}`;
  // The requests that flagged each change's edits. A request there about one of those edits, such as Revise or Undo
  // from its card, stays in the request that raised the doubt, which lists the edit, and doesn't join the two.
  const raisedIn = new Map<string, Set<string>>();
  const byId = new Map(tasks.map(t => [t.id, t]));
  for (const c of d.changes) for (const flag of c.flags ?? []) {
    const raiser = byId.get(flag.taskId);
    if (raiser) (raisedIn.get(c.id) ?? raisedIn.set(c.id, new Set()).get(c.id)!).add(raiser.context.threadId ?? raiser.id);
  }
  for (const t of tasks) {
    g.add(key("t", t.id));
    if (t.retryTaskId) g.union(key("t", t.id), key("t", t.retryTaskId));
    if (t.context.threadId) g.union(key("x", t.context.threadId), key("t", t.id));
    if (t.context.changeId && !(t.context.threadId && raisedIn.get(t.context.changeId)?.has(t.context.threadId)))
      g.union(key("c", t.context.changeId), key("t", t.id));
    for (const c of t.changeIds) g.union(key("t", t.id), key("c", c));
  }
  const feedbackChanges = new Map<string, string>();
  for (const note of d.notes) {
    if (note.changeId) feedbackChanges.set(note.id, note.changeId);
  }
  for (const c of d.changes) {
    g.add(key("c", c.id));
    if (c.threadId) g.union(key("x", c.threadId), key("c", c.id));
    if (c.taskId) g.union(key("t", c.taskId), key("c", c.id));
    for (const noteId of c.noteIds) {
      const previousChange = feedbackChanges.get(noteId);
      if (previousChange) g.union(key("c", previousChange), key("c", c.id));
    }
  }

  const byRoot = new Map<string, { tasks: Task[]; changes: Change[]; explicit?: string }>();
  const bucket = (k: string) => {
    const r = g.find(k);
    let b = byRoot.get(r);
    if (!b) byRoot.set(r, (b = { tasks: [], changes: [] }));
    return b;
  };
  for (const t of tasks) {
    const b = bucket(key("t", t.id));
    b.tasks.push(t);
    b.explicit ??= t.context.threadId;
  }
  for (const c of d.changes) {
    const b = bucket(key("c", c.id));
    b.changes.push(c);
    b.explicit ??= c.threadId;
  }

  const threads: Thread[] = [];
  for (const b of byRoot.values()) {
    b.tasks.sort((x, y) => ts(x.createdAt) - ts(y.createdAt));
    b.changes.sort((x, y) => ts(x.createdAt) - ts(y.createdAt));
    const first = b.tasks[0];
    // Legacy proposals can predate their first linked task, which is the editor's revision.
    const originalChange = first?.kind === "revise" || first?.context.changeId ? b.changes[0] : undefined;
    const id = b.explicit ?? originalChange?.id ?? first?.id ?? b.changes[0]!.id;
    const lastProposal = b.changes.at(-1);
    const latest = b.changes.findLast(c => (c.intent === "alternative" || c.intent === "suggestion") && c.state === "ready")
      ?? (lastProposal?.intent === "alternative" ? b.changes.findLast(c => c.taskId === lastProposal.taskId && c.state === "approved") : undefined)
      ?? lastProposal;
    const question = b.tasks.find((t) => t.state === "waiting_for_user" && !!t.question);
    const active = b.tasks.find((t) => ACTIVE.has(t.state));
    const lastTask = b.tasks.at(-1);
    const recovery = lastTask && !lastTask.retryTaskId && taskRecoveryAction(lastTask, b.changes.some(c => c.taskId === lastTask.id));
    const finishedRevision = latest?.state === "revising" && b.tasks.some(t => t.kind === "revise" &&
      t.context.changeId === latest.id && ["done", "failed", "cancelled"].includes(t.state));
    let status: ThreadStatus;
    let needs: Thread["needs"];
    if (question) {
      status = "needs_you";
      needs = "question";
    } else if (!active && lastTask?.state === "failed" && recovery && !(recovery === "resume" && latest?.state === "ready")) {
      status = "needs_you";
      needs = lastTask.interrupted ? "interrupted" : "task_failed";
    } else if (active && latest && sameRun(active, b.tasks.find(t => t.id === latest.taskId)) && latest.state === "ready" && latest.intent === "suggestion" &&
        !active.context.reviewAllCuts && latest.cutAssessments?.some(a => isPublishedCall(a) && !latest.cutChoices?.some(c => c.index === a.index))) {
      status = "needs_you";
      needs = "decision";
    } else if (active || (latest && WORKING_CHANGE.has(latest.state) && !finishedRevision)) {
      status = "working";
    } else if (latest && (latest.state === "ready" || latest.state === "failed")) {
      status = "needs_you";
      needs = latest.state === "failed" ? "failed" : "decision";
    } else if (latest?.state === "approved") {
      status = "done";
    } else {
      status = "closed";
    }
    const createdAt = [first?.createdAt, b.changes[0]?.createdAt].filter(Boolean).sort()[0] ?? "";
    const updatedAt =
      [...b.tasks.map((t) => t.finishedAt ?? t.startedAt ?? t.createdAt), ...b.changes.map((c) => c.updatedAt ?? c.createdAt)]
        .filter((x): x is string => !!x)
        .sort()
        .pop() ?? createdAt;
    threads.push({
      id,
      title: first && !originalChange ? (first.context.message === "Make first cut" ? "First edit" : requestText(first)) : cutSummary((originalChange ?? b.changes[0]!).description),
      status,
      needs,
      tasks: b.tasks,
      changes: b.changes,
      latest,
      question,
      active,
      author: first?.createdBy ?? b.changes[0]?.author,
      createdAt,
      updatedAt,
    });
  }
  // A doubt about an edit goes to the request that raised it, where the editor is looking, not to the one that made it.
  const byTask = new Map(threads.flatMap(thread => thread.tasks.map(task => [task.id, thread] as const)));
  for (const change of d.changes) for (const flag of change.flags ?? []) {
    const thread = byTask.get(flag.taskId);
    if (!thread || thread.changes.includes(change) || thread.flagged?.includes(change)) continue;
    (thread.flagged ??= []).push(change);
  }
  // A later version of a flagged edit, revised or undone from the request that made it, comes too: the request that
  // raised the doubt lists the edit as it is now. Oldest first, so each version follows the one it replaces.
  const byAge = d.changes.toSorted((x, y) => ts(x.createdAt) - ts(y.createdAt));
  for (const thread of threads) {
    const flagged = thread.flagged;
    if (!flagged) continue;
    for (const change of byAge) {
      if (thread.changes.includes(change) || flagged.includes(change)) continue;
      if (change.timelineEdits?.some(e => e.replaces && flagged.some(f => f.id === e.replaces!.changeId))) flagged.push(change);
    }
    flagged.sort((x, y) => ts(x.createdAt) - ts(y.createdAt));
  }
  return threads;
}

/** A run that was interrupted carries on under a new task. Both are the same run. */
export function sameRun(a: Task, b: Task | undefined): boolean {
  return !!b && (a.resumeRootId ?? a.id) === (b.resumeRootId ?? b.id);
}

/**
 * A note's own words, and what was said back about it. Replies used to be appended to the note's text as
 * "\n\n— name: reply", under the name of whoever was signed in, which made the agent's reply read as the editor's and
 * the note no longer match the request it was sent as. Those are read back out of an older note here.
 */
export function noteThread(note: Pick<Note, "text" | "replies">): { text: string; replies: { text: string; author?: Author; createdAt?: string }[] } {
  const [own = "", ...appended] = note.text.split(/\n\n— (?=[^\n:]{1,80}: )/);
  return { text: own, replies: [...appended.map(part => ({ text: part.slice(part.indexOf(": ") + 2) })), ...(note.replies ?? [])] };
}

/** What the person asked, without the history Scarlet adds for the agent. */
export function requestText(t: Task): string {
  return t.context.message ?? t.instruction;
}

/**
 * What a request is, known when it is sent: a dialogue pass, or a request about one staged cut of a pass. It sets what
 * the chat shows while Scarlet works. A pass shows the stages Scarlet measures and a request about one cut its own two;
 * any other request has no kind, and shows the plan its agent lays out.
 */
export type RunKind = "pass" | "cut";

/** Whole whitespace-delimited tokens, also used to locate commands in the composer. */
export function skillCommands(draft: string) {
  return Array.from(draft.matchAll(/(?:^|\s)(\/([a-z0-9][a-z0-9-]*)?)(?=\s|$)/gi), match => {
    const end = match.index + match[0].length;
    return { start: end - match[1]!.length, end, name: (match[2] ?? "").toLowerCase() };
  });
}

function firstCutName(name: string | undefined) {
  return name === "dialogue-pass" || name === "first-cut-dialogue";
}

/**
 * The guides a skill builds on, in the order it names them. It names one by calling it in its text, `/frame-screen`,
 * at the place it applies, with what it changes written beside the call; or in its header, `extends: dialogue-pass`,
 * several with commas between them. An editor's own style ("cut my joins tighter, frame my demos my way") then runs
 * with the guides it adds to, and their later improvements reach it, instead of a copy of each guide drifting apart
 * from it. A name is only a guide when the library has one by it, which the caller checks.
 */
export function skillExtends(skill: Pick<Skill, "content"> & Partial<Pick<Skill, "name">>): string[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(skill.content);
  const value = front && /^extends:[ \t]*(.*)$/m.exec(front[1]!)?.[1]?.trim().replace(/^\[|\]$/g, "");
  const header = (value ?? "").split(",").map(name => name.trim().replace(/^["']|["']$/g, "").replace(/^\//, "")).filter(Boolean);
  // A call in the text: a whole word after a space or an opening bracket, so a path or a name in code isn't one.
  const body = skill.content.slice(front?.[0].length ?? 0);
  const called = Array.from(body.matchAll(/(?:^|[\s(])\/([a-z0-9][a-z0-9-]*)(?=[\s.,;:!?)]|$)/gim), match => match[1]!.toLowerCase());
  const own = skill.name ?? (front && /^name:[ \t]*(.*)$/m.exec(front[1]!)?.[1]?.trim());
  return [...new Set([...header, ...called])].filter(name => name !== own);
}

/** Whether a skill adds to the dialogue pass, so its command asks for one. */
export function extendsDialoguePass(skill: Skill) {
  return skill.enabled && !isDialogueGuide(skill) && skillExtends(skill).some(firstCutName);
}

export function isDialogueGuide(skill: Skill) {
  return firstCutName(skill.name) && (skill.bundledName === skill.name ||
    (!skill.bundledName && (skill.source === "bundled" || skill.source === "seed")));
}

type DialogueOperation = NonNullable<Task["context"]["dialogueOperation"]>;

/** A custom entry owns its command name even when disabled. The shipped guide is optional advice for the product shortcut. */
export function dialogueShortcut(name: string, library: readonly Skill[]): DialogueOperation | undefined {
  const entry = library.find(skill => skill.name === name);
  if (entry && extendsDialoguePass(entry)) return "first-cut";
  if (!firstCutName(name) && name !== "tighten-pauses-here") {
    if (entry?.enabled && firstCutName(entry.bundledName)) return "first-cut";
    return;
  }
  if (entry && !isDialogueGuide(entry)) return;
  return name === "tighten-pauses-here" ? "local-pauses" : "first-cut";
}

/** Resolve the last explicit product shortcut against the library at the time the editor sent it. */
export function dialogueCommand(text: string, library: readonly Skill[] = []): DialogueOperation | undefined {
  let chosen: DialogueOperation | undefined;
  for (const { name } of skillCommands(text)) chosen = dialogueShortcut(name, library) ?? chosen;
  return chosen;
}

/** Older tasks can lack a recorded operation. Their message and subsequent editor answers identify the shortcut. */
export function taskDialogueOperation(task: Pick<Task, "context" | "instruction">, answers: readonly string[] = [], library: readonly Skill[] = []): DialogueOperation {
  if (task.context.dialogueOperation !== undefined) return task.context.dialogueOperation;
  let chosen = dialogueCommand(task.context.message ?? task.instruction, library) ?? "none";
  for (const answer of answers) chosen = dialogueCommand(answer, library) ?? chosen;
  return chosen;
}

export function taskRunKind(task: Pick<Task, "context" | "instruction">): RunKind | undefined {
  if (task.context.cutIndex !== undefined) return "cut";
  if (task.context.editIndex === undefined && taskDialogueOperation(task) !== "none") return "pass";
}

const ACTIVE_STATES = new Set(["claimed", "running", "waiting_for_user"]);

const PENDING_STATES = new Set(["queued", ...ACTIVE_STATES]);

export type QueueTask = Pick<Task, "id" | "projectId" | "kind" | "state" | "createdAt" | "resumeRootId" | "queueSequence" | "startsBeforeCalls" | "resumesAfterProjectStop"> & {
  context: Pick<Task["context"], "branch" | "changeId" | "threadId" | "cutIndex" | "editIndex">;
};
type EditLineage = Pick<Change, "id" | "timelineEdits">;
/**
 * What the queue reads of a change: whether it is a pass waiting on the editor, and which run and thread made it.
 * Only how many cut reasons a pass has matters, so the engine can read the count instead of every reason.
 */
export type QueueChange = Pick<Change, "id" | "projectId" | "taskId" | "threadId" | "state" | "intent"> & {
  cutReasons?: { readonly length: number };
};

/**
 * A dialogue pass whose staged cuts still need the editor. A request built on the edit before those cuts are
 * decided could block applying them, so new requests wait for it, except ones about the pass itself. A pass with one
 * cut sent back for revision is still open while that revision is queued or running: an earlier request let through
 * then would move the edit on, and the revision would be refused as out of date. Once the revision has run, its new
 * version is the pass that waits. The version it replaced stays marked as revising, and holds nothing.
 */
export function openDialogueReview(change: QueueChange, tasks: readonly QueueTask[]): boolean {
  if (change.intent !== "suggestion" || !change.cutReasons?.length) return false;
  return change.state === "ready"
    || (change.state === "revising" && tasks.some(t => t.projectId === change.projectId && PENDING_STATES.has(t.state) && t.context.changeId === change.id));
}

/** A reply in the pass's thread or a revision of it works on the pass, so the pass doesn't hold it back. */
export function aboutChange(task: QueueTask, change: Pick<QueueChange, "id" | "threadId">): boolean {
  return (task.context.threadId ?? task.id) === change.threadId || task.context.changeId === change.id;
}

export type QueueWait =
  | { kind: "question"; task: Task }
  | { kind: "run"; task: Task }
  | { kind: "ahead"; count: number }
  | { kind: "review"; change: Change };

const editsVideo = (task: QueueTask) => task.kind !== "transcribe" && !isAsideTask(task);

/** The dialogue passes waiting on the editor on a request's branch. */
function reviewIndex<C extends QueueChange>(tasks: readonly QueueTask[], changes: readonly C[]) {
  const makers = new Map(tasks.map(task => [task.id, task]));
  const byBranch = new Map<string, C[]>();
  const key = (projectId: string, branch?: string) => JSON.stringify([projectId, branch]);
  for (const change of changes) {
    const maker = change.taskId ? makers.get(change.taskId) : undefined;
    if (!maker || !openDialogueReview(change, tasks)) continue;
    const branch = key(change.projectId, maker.context.branch);
    const reviews = byBranch.get(branch);
    if (reviews) reviews.push(change);
    else byBranch.set(branch, [change]);
  }
  return (task: QueueTask): readonly C[] => byBranch.get(key(task.projectId, task.context.branch)) ?? [];
}

/**
 * A pass a run is still making: the run saved it, and every earlier save it took the place of, as a pass does part by
 * part. A request about a call of a pass that already waited saves the pass again under its own run, in place of the
 * one another run staged. That pass waited on the editor before the request began and waits on them still.
 */
function stillMaking(pass: Change, run: Task, tasks: readonly Task[], changes: readonly Change[], hops = 0): boolean {
  if (!sameRun(run, tasks.find(t => t.id === pass.taskId))) return false;
  return hops > 50 || changes.every(c => c.replacedBy !== pass.id || !c.cutReasons?.length || stillMaking(c, run, tasks, changes, hops + 1));
}

/**
 * The one cut or edit a request is about, when it is about one, as a key two requests share exactly when they are about
 * the same thing. Undefined for a request about the whole video.
 *
 * - A call of a pass (`cutIndex`): `["call", thread, cutIndex]`. Every version of a pass is saved in the pass's thread,
 *   and a revision of one call saves the whole pass again under a new id, so the thread names the pass across its versions.
 * - An applied edit (`editIndex`), revised or undone from its card or from the list of the request that flagged it:
 *   `["edit", changeId, spot]` of the edit's first version. A revision is a new change whose edit `replaces` the one it
 *   revised, so with `changes` the chain is followed back to where the edit was first made; requests about it then name
 *   the same edit whichever version they were sent about, and whichever thread they were sent from.
 *
 * The engine and tray both use this lineage to decide which edits can run together.
 */
export function requestTargetKey(task: QueueTask, changes: readonly EditLineage[] = []): string | undefined {
  return targetKey(task, lineageOf(changes));
}

function targetKey(task: QueueTask, changeById: (id: string) => EditLineage | undefined): string | undefined {
  const { changeId, cutIndex, editIndex, threadId } = task.context;
  if (!changeId || (cutIndex === undefined && editIndex === undefined)) return undefined;
  if (cutIndex !== undefined) return JSON.stringify(["call", threadId ?? task.id, cutIndex]);
  let at = { changeId, spot: editIndex! };
  for (let hops = 0; hops < 50; hops++) {
    const back = changeById(at.changeId)?.timelineEdits?.[at.spot]?.replaces;
    if (!back) break;
    at = back;
  }
  return JSON.stringify(["edit", at.changeId, at.spot]);
}

/**
 * Scarlet works on two requests at once when each is about one cut or edit and they are about different ones: each
 * agent then works on its own footage. A call's revision is saved into the pass as it stands when it lands, with the
 * other revisions and the editor's calls made meanwhile. An applied edit's revision is put onto the video as it is
 * when it lands, and one that meets footage another request changed is told so, with where, and saves again on the
 * current video. Any other request is about the whole video, or about footage nothing names ahead of time, so it runs
 * alone. Two requests about the same cut or edit keep the order they were asked in. What counts as the same cut or
 * edit comes from requestTargetKey.
 */
const differentTargets = (a?: string, b?: string): boolean => a !== undefined && b !== undefined && a !== b;

/**
 * The order requests were asked in. A resumed run keeps the place of the run it continues. Requests saved in the same
 * millisecond keep the order the engine saved them in (`queueSequence`, its row number). A task the engine didn't
 * number, as the demo's are, follows the numbered ones of its millisecond, in the order the snapshot lists them: row
 * numbers and positions in a list are never compared with each other.
 */
function inLine(tasks: readonly QueueTask[]) {
  type Place = { createdAt: string; sequence?: number; index: number };
  const positions = new Map<string, Place>(tasks.map(({ id, createdAt, queueSequence }, index) =>
    [id, { createdAt: createdAt ?? "", sequence: queueSequence, index }]));
  const compare = (x: Place, y: Place) => x.createdAt !== y.createdAt ? (x.createdAt < y.createdAt ? -1 : 1)
    : (x.sequence === undefined ? 1 : 0) - (y.sequence === undefined ? 1 : 0)
      || (x.sequence ?? 0) - (y.sequence ?? 0) || x.index - y.index;
  const place = (task: QueueTask) => {
    const attempt = positions.get(task.id) ?? { createdAt: task.createdAt ?? "", sequence: task.queueSequence, index: tasks.length };
    const root = task.resumeRootId ? positions.get(task.resumeRootId) : undefined;
    return { original: root ?? attempt, attempt };
  };
  return (a: QueueTask, b: QueueTask) => {
    const x = place(a), y = place(b);
    return Number(!!b.resumesAfterProjectStop) - Number(!!a.resumesAfterProjectStop)
      || compare(x.original, y.original) || compare(x.attempt, y.attempt);
  };
}

/** Each change by its id, to follow an edit back through its revisions. */
function lineageOf(changes: readonly EditLineage[]) {
  const byId = new Map(changes.map(change => [change.id, change]));
  return (id: string) => byId.get(id);
}

function queuePolicy<T extends QueueTask, C extends QueueChange>(tasks: readonly T[], changes: readonly C[],
  lookup: (id: string) => EditLineage | undefined) {
  const reviews = reviewIndex(tasks, changes);
  const order = inLine(tasks);
  const edits = tasks.filter(editsVideo);
  const active = edits.filter(task => ACTIVE_STATES.has(task.state));
  const queued = edits.filter(task => task.state === "queued").sort(order);
  const keys = new Map<T, string | undefined>();
  const keyOf = (task: T) => {
    if (!keys.has(task)) keys.set(task, targetKey(task, lookup));
    return keys.get(task);
  };
  const others = (task: T, other: T) => task.id !== other.id && task.projectId === other.projectId
    && !differentTargets(keyOf(task), keyOf(other));
  const holding = (task: T) => task.startsBeforeCalls ? [] : reviews(task).filter(change => !aboutChange(task, change));
  const ahead = (task: T, prior: T) => others(task, prior) && order(prior, task) < 0
    && !reviews(task).some(change => aboutChange(task, change) && !aboutChange(prior, change));
  const running = (task: T) => active.find(other => others(task, other));
  const blocker = (task: T, remaining: readonly T[] = queued) => {
    const run = running(task);
    if (run) return { reason: run.state === "waiting_for_user" ? "question" : "active_run", id: run.id } as const;
    const review = holding(task)[0];
    if (review) return { reason: "review", id: review.id } as const;
    const prior = remaining.find(other => ahead(task, other));
    return prior ? { reason: "earlier_request", id: prior.id } as const : undefined;
  };

  return { active, queued, holding, ahead, running, blocker,
    canClaim: (task: T, remaining?: readonly T[]) => blocker(task, remaining) === undefined };
}

/**
 * Whether the engine may start a queued request now. The engine loads only pending tasks, their chronological roots
 * and the makers of open reviews, and the columns of each change the queue reads; `lookup` reads an edit's lineage
 * only for a request about an applied edit.
 */
export function queueAdmission(tasks: readonly QueueTask[], changes: readonly QueueChange[], lookup: (id: string) => EditLineage | undefined) {
  const policy = queuePolicy(tasks, changes, lookup);
  return policy.canClaim;
}

/** The first reason admission would hold this request, using the same policy as the editor's queue. */
export function queueBlocker(tasks: readonly QueueTask[], changes: readonly QueueChange[], lookup: (id: string) => EditLineage | undefined) {
  return queuePolicy(tasks, changes, lookup).blocker;
}

/** A pass being staged is described as a run while Scarlet is making it. */
function heldBy(reviews: readonly Change[], active: readonly Task[], tasks: readonly Task[], changes: readonly Change[]): Change | undefined {
  return reviews.find(change => !active.some(run => stillMaking(change, run, tasks, changes)));
}

/**
 * Why each queued request hasn't started, for one snapshot of a project's tasks and changes. The rules are worked out
 * once for the snapshot, so asking about every queued request costs one pass, not one per request.
 */
export function queueWaits(tasks: readonly Task[], changes: readonly Change[]): (task: Task) => QueueWait | undefined {
  const policy = queuePolicy(tasks, changes, lineageOf(changes));
  const answers = new Map<Task, QueueWait | undefined>();
  const wait = (task: Task): QueueWait | undefined => {
    if (task.state !== "queued" || !editsVideo(task)) return undefined;
    const running = policy.running(task);
    if (running?.state === "waiting_for_user") return { kind: "question", task: running };
    const active = policy.active.filter(other => other.projectId === task.projectId);
    const open = policy.holding(task);
    const review = heldBy(open, active, tasks, changes);
    if (running) return review ? { kind: "review", change: review } : { kind: "run", task: running };
    const ahead = policy.queued.filter(prior => policy.ahead(task, prior)).length;
    if (ahead) return { kind: "ahead", count: ahead };
    if (review) return { kind: "review", change: review };
    const making = active.find(run => open.some(change => stillMaking(change, run, tasks, changes)));
    return making ? { kind: "run", task: making } : undefined;
  };
  return task => {
    if (!answers.has(task)) answers.set(task, wait(task));
    return answers.get(task);
  };
}

/** Why a queued request hasn't started. To ask about several requests in one snapshot, use queueWaits. */
export function queueWait(task: Task, tasks: readonly Task[], changes: readonly Change[]): QueueWait | undefined {
  return queueWaits(tasks, changes)(task);
}

/** Work eligible beside an active edit comes first, followed by the order once active work finishes. */
export function queueOrder(tasks: readonly Task[], changes: readonly Change[]): Task[] {
  const policy = queuePolicy(tasks, changes, lineageOf(changes));
  let waiting = policy.queued;
  const order: Task[] = [];
  for (;;) {
    const next = waiting.find(task => policy.canClaim(task, waiting)) ?? waiting.find(task => {
      const active = policy.active.filter(other => other.projectId === task.projectId);
      return !heldBy(policy.holding(task), active, tasks, changes) && !waiting.some(prior => policy.ahead(task, prior));
    });
    if (!next) return [...order, ...waiting];
    order.push(next);
    waiting = waiting.filter(task => task.id !== next.id);
  }
}

/**
 * The number of each call of a dialogue pass, by its cut's index: the order the calls reached the editor in, as the
 * window shows it ("Cut 2"). Anything else that names a call by its number uses this too, so the two can't disagree.
 * Scarlet's asks go in the order it made them, as the engine numbers them (`askOrder`). The cuts it never checked
 * follow in timeline order once its run is over (`over`). A later ask about a cut earlier in the video, or the cuts
 * a pass hands over when it ends, never renumber the calls the editor has seen. A pass whose asks aren't numbered, as one saved before the engine
 * numbered them, has them all in timeline order, as every call was then. Once it numbers them, an ask without a number
 * is a cut no one checked that the editor sent back, and it stays among those. `cuts` is how many cuts the pass's
 * review lists: staged cuts that touch are one.
 */
export function callNumbers(pass: Pick<Change, "cutAssessments" | "cutChoices">, cuts: number, over: boolean): Map<number, number> {
  const assessed = pass.cutAssessments?.filter(a => !a.provisional) ?? [];
  const decided = new Set(pass.cutChoices?.map(c => c.index));
  const calls: Array<{ index: number; askOrder?: number }> = assessed.filter(a => isPublishedCall(a) || (a.askOrder !== undefined && decided.has(a.index)));
  if (over) {
    const checked = new Set(assessed.map(a => a.index));
    for (let index = 0; index < cuts; index++) if (!checked.has(index)) calls.push({ index });
  }
  calls.sort((a, b) => (a.askOrder ?? Infinity) - (b.askOrder ?? Infinity) || a.index - b.index);
  return new Map(calls.map((call, i) => [call.index, i + 1]));
}

/**
 * The run that staged a pass is over: it finished, or stopped before it did. Revising one cut replaces the pass under
 * the revision's own request, so the run is found back through the passes each revision replaced, and then at its
 * latest attempt.
 */
function passRunOver(pass: Change, changes: readonly Change[], tasks: readonly Task[]): boolean {
  let run = tasks.find(t => t.id === pass.taskId);
  for (let hops = 0; run?.context.cutIndex !== undefined && run.context.changeId && hops < 50; hops++) {
    const replaced = changes.find(c => c.id === run!.context.changeId);
    const before = replaced && replaced.taskId !== run.id ? tasks.find(t => t.id === replaced.taskId) : undefined;
    if (!before) break;
    run = before;
  }
  for (let hops = 0; run?.retryTaskId && hops < 50; hops++) {
    const next = tasks.find(t => t.id === run!.retryTaskId);
    if (!next) break;
    run = next;
  }
  return run?.state === "done" || run?.state === "failed" || run?.state === "cancelled";
}

/**
 * Which of this pass's cuts a request about one cut means. A request sent while the pass ran waits its turn naming the
 * proposal the editor saw then, which later parts of the pass have replaced: the cut is followed from part to part by
 * its range, as the chat follows it, so the request is counted against the same call there. Undefined when the request
 * isn't about a cut of this pass, or its cut is no longer in it.
 */
function cutInPass(pass: Change, { changeId, cutIndex }: Task["context"], changes: readonly Change[], tasks: readonly Task[]): number | undefined {
  if (!changeId || cutIndex === undefined) return undefined;
  if (changeId === pass.id) return cutIndex;
  const same = (a: TimeRange, b: TimeRange) => Math.abs(a.start - b.start) < 0.05 && Math.abs(a.end - b.end) < 0.05;
  const staged = (c: Change) => mergeRanges((c.cutReasons ?? []).map(({ start, end }) => ({ start, end })));
  // The proposal that took one's place: the one named on it, or the one a revision of one of its cuts made from it.
  const after = (from: Change) => changes.find(c => c.id === from.replacedBy) ?? changes.find(c => c.id !== from.id && !!c.cutReasons
    && tasks.some(t => t.id === c.taskId && t.kind === "revise" && t.context.changeId === from.id && t.context.cutIndex !== undefined));
  let change = changes.find(c => c.id === changeId);
  let cut = change && staged(change)[cutIndex];
  let index = cutIndex;
  for (let hops = 0; change && cut && hops < 500; hops++) {
    if (change.id === pass.id) return index;
    const next = after(change);
    if (!next?.cutReasons) return undefined;
    const cuts = staged(next);
    // A cut published by this pass keeps its ask order across its replacements, even when both its slot and
    // its time change. Older passes without this identity still follow their footage.
    const order = change.cutAssessments?.find(a => a.index === index)?.askOrder;
    const published = order !== undefined && next.cutAssessments?.find(a => a.askOrder === order);
    if (published && cuts[published.index]) {
      change = next; index = published.index; cut = cuts[index];
      continue;
    }
    let found = cuts.findIndex(r => same(r, cut!));
    if (found < 0) {
      // The next part can stage a cut that touches this one, and the review then lists the two as one.
      const ranges = [cut, ...(change.cutReasons ?? []).filter(r => r.start >= cut!.start && r.end <= cut!.end)];
      const carried = next.cutReasons.filter(r => ranges.some(range => same(r, range)));
      found = cuts.findIndex(r => rangesOverlap(r, cut!) && carried.some(kept => kept.start >= r.start && kept.end <= r.end));
    }
    const at = found >= 0 ? found : index;
    const moved = cuts[at];
    if (!moved || !rangesOverlap(moved, cut)) return undefined;
    change = next; index = at; cut = moved;
  }
  return undefined;
}

/**
 * A dialogue pass's calls that still wait on the editor: the cuts Scarlet asked about, less the ones already called
 * or sent back for revision. Once the run is over, a staged cut it never checked is the editor's call too, whether the
 * run stopped early or finished without getting to it: nobody else will check it (2026-11-10). Staged cuts that touch
 * are one cut, as the pass's review numbers them.
 */
function waitingCalls(pass: Change, { changes, tasks }: Pick<Source, "changes" | "tasks">): number {
  const called = new Set(pass.cutChoices?.map(choice => choice.index));
  const sentBack = new Set(tasks.flatMap(t => {
    if (!PENDING_STATES.has(t.state)) return [];
    const index = cutInPass(pass, t.context, changes, tasks);
    return index === undefined ? [] : [index];
  }));
  const waits = (index: number) => !called.has(index) && !sentBack.has(index);
  const asked = pass.cutAssessments?.filter(a => isPublishedCall(a) && waits(a.index)).length ?? 0;
  if (!passRunOver(pass, changes, tasks)) return asked;
  const checked = new Set(pass.cutAssessments?.filter(a => !a.provisional).map(a => a.index));
  return asked + mergeRanges(pass.cutReasons ?? []).filter((_, index) => !checked.has(index) && waits(index)).length;
}

/**
 * What waits on the editor in a project, counted as its chat counts it ("N need you"): each call of a dialogue pass
 * that is still open, and one for each question Scarlet asked. A suggestion with no call left to make, whether a pass
 * or any other, waits on the one decision to apply it, unless its thread was filed since it last changed. While
 * Scarlet is still at work on a request, only the calls it has already asked for wait. A flagged edit the editor
 * hasn't kept is not counted: which edits were kept is saved in the window, not here.
 */
export function countReviewDecisions(source: Source, completed?: Record<string, string>): number {
  let count = 0;
  for (const thread of buildThreads(source)) {
    if (thread.question) count++;
    const pass = thread.changes.findLast(c => openDialogueReview(c, source.tasks));
    const calls = pass ? waitingCalls(pass, source) : 0;
    if (calls) count += calls;
    else if (!thread.active && thread.needs === "decision" && !isThreadDone(thread, completed)) count++;
  }
  return count;
}
