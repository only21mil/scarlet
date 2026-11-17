import type { Timeline } from "@scarlet/timeline";
import { api } from "./client";

/** How many saved versions' timelines the window keeps, the latest used last. */
const KEPT = 16;

/**
 * Saved versions' timelines, read once and shared by everything that shows one: a saved version never changes. A
 * read on its way is shared too, and one that failed is let go, so the next asks again. The newest used stay.
 */
const kept = new Map<string, { read: Promise<Timeline>; from: typeof api.timeline }>();

/**
 * One saved version's timeline. `signal` lets go of the wait, not the read, which others may share. "head" is not a
 * saved version and is read each time.
 */
export function readTimeline(projectId: string, version: string, signal?: AbortSignal): Promise<Timeline> {
  if (version === "head") return api.timeline(projectId, version, signal).then(({ timeline }) => timeline);
  const key = JSON.stringify([projectId, version]);
  // What another client read, such as a test's stand-in for the engine, isn't this one's.
  let entry = kept.get(key);
  kept.delete(key);
  if (entry?.from !== api.timeline) {
    const read: Promise<Timeline> = api.timeline(projectId, version).then(({ timeline }) => timeline);
    read.catch(() => { if (kept.get(key)?.read === read) kept.delete(key); });
    entry = { read, from: api.timeline };
  }
  kept.set(key, entry);
  while (kept.size > KEPT) kept.delete(kept.keys().next().value!);
  return released(entry.read, signal);
}

function released<T>(read: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    read.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
