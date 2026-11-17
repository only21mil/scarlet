import type { Task } from "@scarlet/shared";

/** The run a task belongs to: its first attempt, which each resumed attempt names as `resumeRootId`. */
export const runRoot = (task: Pick<Task, "id" | "resumeRootId">): string => task.resumeRootId ?? task.id;

/**
 * Every attempt of a run, as a condition on the `tasks` table (unaliased) and its parameters: the first attempt and
 * each resume of it, in its own project.
 */
export function runAttempts(projectId: string, rootId: string): { where: string; params: [string, string, string] } {
  // Start from the two run ids' indexes. A project can have thousands of unrelated tasks.
  return { where: "+project_id = ? AND (id = ? OR json_extract(json, '$.resumeRootId') = ?)", params: [projectId, rootId, rootId] };
}

/** The ids of every attempt of a run, as a subquery to put in parentheses, and its parameters. */
export function runAttemptIds(projectId: string, rootId: string): { sql: string; params: [string, string, string] } {
  const { where, params } = runAttempts(projectId, rootId);
  // JSON links elsewhere have no column affinity. Keep these ids indexable when matched against them.
  return { sql: `SELECT +id FROM tasks WHERE ${where}`, params };
}
