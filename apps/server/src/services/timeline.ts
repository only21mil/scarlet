import { createHash } from "node:crypto";
import { contentHash, emptyTimeline, sameContent, stableStringify, Id, WritableTimeline, type Author, type Project, type Timeline } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { badRequest, notFound } from "../errors.js";

/** Version id: first 16 hex of sha256 of the stable JSON of the timeline content. */
function versionIdFor(tl: Timeline): string {
  const { version, parent, createdAt, ...content } = tl;
  return createHash("sha256").update(stableStringify(content)).digest("hex").slice(0, 16);
}

type VersionMeta = { parent: string | null; author?: Author; changeId?: string | null; description?: string };

/**
 * Store a timeline as an immutable version. Same content → same id; an
 * existing version is returned untouched (first writer wins on parent).
 */
export function storeVersion(ctx: Ctx, projectId: string, input: Timeline, meta: VersionMeta): Timeline {
  return storeValidatedVersion(ctx, WritableTimeline.parse({ ...input, projectId }), meta);
}

/** The proposal path has already applied WritableTimeline validation. Hash its result once. */
export function storeValidatedVersion(ctx: Ctx, normalized: Timeline, meta: VersionMeta, differentFrom?: Timeline): Timeline {
  const { projectId } = normalized;
  if (differentFrom && normalized.name === differentFrom.name && normalized.markers.length === differentFrom.markers.length &&
      sameContent(normalized, differentFrom))
    throw badRequest("no_change", "the proposed timeline is identical to fromVersion");
  const content = versionIdFor(normalized);
  // Identical footage can be reached by different edits on different branches.
  const version = meta.changeId
    ? contentHash({ content, parent: meta.parent, changeId: meta.changeId }).slice(0, 16)
    : content;
  const existing = ctx.repos.versions.get(projectId, version);
  if (existing) return existing.timeline;
  const tl = { ...normalized, version, parent: Id.nullable().parse(meta.parent), createdAt: now() };
  return ctx.repos.versions.insert({
    version,
    projectId,
    parent: meta.parent,
    timeline: tl,
    author: meta.author,
    changeId: meta.changeId ?? null,
    description: meta.description,
    createdAt: tl.createdAt!,
  }, true).timeline;
}

/** Resolve "head" / a version id / undefined to a timeline. No head → emptyTimeline. */
export function resolveTimeline(ctx: Ctx, project: Pick<Project, "id" | "head">, version?: string | null): Timeline {
  const v = !version || version === "head" ? project.head : version;
  if (!v) {
    if (version && version !== "head") throw notFound(`version ${version}`);
    return emptyTimeline(project.id);
  }
  const row = ctx.repos.versions.get(project.id, v);
  if (!row) throw notFound(`version ${v}`);
  return row.timeline;
}

/** A note, branch switch or proposal needs the current version id even on a new project. */
export function ensureProjectHead(ctx: Ctx, projectId: string): Omit<Project, "media"> & { head: string } {
  const project = ctx.repos.projects.header(projectId);
  if (!project) throw notFound("project");
  if (project.head && ctx.repos.versions.exists(projectId, project.head)) return { ...project, head: project.head };

  const empty = storeVersion(ctx, projectId, emptyTimeline(projectId), {
    parent: null,
    author: { type: "scarlet", name: "Scarlet" },
    description: "Empty timeline",
  });
  ctx.repos.projects.initializeHead(projectId, project.head, empty.version);
  const current = ctx.repos.projects.header(projectId);
  if (!current?.head || !ctx.repos.versions.exists(projectId, current.head)) throw notFound("project head");
  return { ...current, head: current.head };
}

export function ensureHead(ctx: Ctx, projectId: string): { project: Project; head: string; timeline: Timeline } {
  const header = ensureProjectHead(ctx, projectId);
  const project = ctx.repos.projects.withMedia(header);
  return { project, head: header.head, timeline: resolveTimeline(ctx, header) };
}
