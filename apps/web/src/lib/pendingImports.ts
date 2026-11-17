import { appLog, errorName } from "./appLog";
import { MediaAsset } from "@scarlet/timeline";

/**
 * Imports the editor asked for that haven't finished, kept on this computer so a quit doesn't drop the files
 * still waiting or the one being copied. `source` is an absolute path or an http(s) link. `setsFormat` marks a
 * new project's first files, whose first video gives the project its format. `started` says whether its copy had
 * begun: only such a file can have reached the project before a quit. An entry saved by an older Scarlet has none.
 */
export interface PendingImport { projectId: string; source: string; at: string; setsFormat?: boolean; started?: boolean; importId?: string; interrupted?: boolean;
  /** How often the engine went away under this file's copy. One saved by an older Scarlet as interrupted has 1. */
  interruptions?: number }

/**
 * How often a copy is begun again after the engine went away under it. Quitting Scarlet is one such time, and so is
 * every restart of the engine, so one is too few: a second quit during the same long copy dropped the file unsaid.
 * A file that takes the engine down every time still stops here.
 */
const INTERRUPTIONS = 5;

const KEY = "scarlet.imports.v1";

let lastReadFailure: string | undefined;

function read(): PendingImport[] {
  let failure: string | undefined;
  let valid: PendingImport[] = [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(saved)) failure = "InvalidShape";
    else {
      valid = saved.filter((i): i is PendingImport =>
        !!i && typeof i.projectId === "string" && typeof i.source === "string" && typeof i.at === "string")
        // Only `true` marks a first file. An entry saved with anything else there is still an import to carry on with.
        .map(({ projectId, source, at, setsFormat, started, importId, interrupted, interruptions }) => ({ projectId, source, at,
          ...(setsFormat === true && { setsFormat }), ...(interrupted === true && { interrupted: true,
            interruptions: Number.isInteger(interruptions) && interruptions! > 0 ? interruptions : 1 }),
          ...(typeof started === "boolean" && { started }), ...(importId && MediaAsset.shape.importId.safeParse(importId).success && { importId }) }));
      if (valid.length !== saved.length) failure = "InvalidEntry";
    }
  } catch (error) {
    failure = errorName(error);
  }
  if (failure && failure !== lastReadFailure) appLog("import", "queue-read-failed", { name: failure }, { level: "warn" });
  lastReadFailure = failure;
  return valid;
}

function write(list: PendingImport[], project: string, operation: string) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch (error) {
    appLog("import", "queue-persist-failed", { project, operation, count: list.length, name: errorName(error) }, { level: "warn" });
  }
}

export function addPendingImports(projectId: string, sources: string[], setsFormat = false) {
  const list = read();
  const at = new Date().toISOString();
  const existing = new Set(list.filter(i => i.projectId === projectId).map(i => i.source));
  for (const source of new Set(sources)) {
    if (!existing.has(source)) list.push({ projectId, source, at, started: false, ...(setsFormat && { setsFormat }) });
  }
  write(list, projectId, "enqueue");
}

/** Persist the identity before sending the request, and use it again if this copy was interrupted. */
export function markImportStarted(projectId: string, source: string) {
  const list = read();
  const entry = list.find(i => i.projectId === projectId && i.source === source);
  if (entry?.importId) return entry.importId;
  const importId = crypto.randomUUID();
  if (entry) write(list.map(i => i === entry ? { ...i, started: true, importId } : i), projectId, "start");
  return importId;
}

/** Keep an interrupted copy to begin again, including after Scarlet itself restarts, until it has been cut off too often. */
export function retryInterruptedImport(projectId: string, source: string) {
  const list = read();
  const entry = list.find(i => i.projectId === projectId && i.source === source);
  const interruptions = (entry?.interruptions ?? 0) + 1;
  const fields = { project: projectId, import: entry?.importId, interruptions };
  if (!entry || interruptions > INTERRUPTIONS) {
    appLog("import", "retry-exhausted", { ...fields, reason: entry ? "retry-limit" : "missing-entry" }, { level: "warn" });
    return false;
  }
  appLog("import", "interrupted", fields, { level: "warn" });
  write(list.map(i => i === entry ? { ...i, interrupted: true, interruptions } : i), projectId, "interrupt");
  return true;
}

export function removePendingImport(projectId: string, source: string) {
  write(read().filter(i => i.projectId !== projectId || i.source !== source), projectId, "remove");
}

/** The project's format is settled, so the files still waiting leave it alone. */
export function clearSetsFormat(projectId: string) {
  const list = read();
  if (!list.some(i => i.projectId === projectId && i.setsFormat)) return;
  write(list.map(i => i.projectId === projectId ? { ...i, setsFormat: undefined } : i), projectId, "clear-format");
}

export function pendingImports(projectId: string) {
  return read().filter(i => i.projectId === projectId);
}

/** Every project with files still to import. */
export function projectsWithPendingImports() {
  return [...new Set(read().map(i => i.projectId))];
}

export const isLink = (source: string) => /^https?:\/\//i.test(source);
