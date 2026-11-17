import { Author, Timeline, timelineDuration } from "@scarlet/timeline";
import type { VersionSummary } from "@scarlet/shared";
import type { Db } from "../db.js";

interface VersionRow {
  version: string;
  projectId: string;
  parent: string | null;
  timeline: Timeline;
  author?: Author;
  changeId: string | null;
  description?: string;
  createdAt: string;
}

interface Raw {
  version: string;
  project_id: string;
  parent: string | null;
  json: string;
  author: string | null;
  change_id: string | null;
  description: string | null;
  created_at: string;
}

const toRow = (r: Raw, timeline: Timeline): VersionRow => ({
  version: r.version,
  projectId: r.project_id,
  parent: r.parent,
  timeline,
  author: r.author ? Author.parse(JSON.parse(r.author)) : undefined,
  changeId: r.change_id,
  description: r.description ?? undefined,
  createdAt: r.created_at,
});

/** Immutable, content-addressed timeline versions. */
export class VersionsRepo {
  // A committed version never changes, apart from the edit that made it being named once (setChangeId), so a version
  // read before is kept validated and found again with a look at its key alone. Only committed reads are kept, and
  // each one returns a copy of its own, as the caller may change it. A purge or another engine's restore that takes
  // the row away is seen by that look.
  private static readonly budget = 64 * 1024 * 1024;
  // A version larger than a quarter of the budget would push out most of the others.
  private static readonly entryLimit = VersionsRepo.budget / 4;
  private static readonly entries = 256;
  private readonly validated = new Map<string, { json: string; row: Omit<VersionRow, "timeline">; bytes: number }>();
  private cachedBytes = 0;

  constructor(private readonly db: Db) {}

  private forget(key: string) {
    const entry = this.validated.get(key);
    if (!entry) return;
    this.validated.delete(key);
    this.cachedBytes -= entry.bytes;
  }

  private remember(key: string, row: VersionRow, json = JSON.stringify(row.timeline)) {
    const { timeline: _timeline, ...rest } = row;
    // JavaScript strings take up to two bytes a character.
    const bytes = (key.length + json.length) * 2;
    if (bytes > VersionsRepo.entryLimit) return;
    // The caller can still edit its copy of the author after this version has been stored.
    if (rest.author) rest.author = { ...rest.author };
    this.db.afterCommit(() => {
      this.forget(key);
      this.validated.set(key, { json, row: rest, bytes });
      this.cachedBytes += bytes;
      for (const [oldKey] of this.validated) {
        if (this.cachedBytes <= VersionsRepo.budget && this.validated.size <= VersionsRepo.entries) break;
        this.forget(oldKey);
      }
    });
  }

  get(projectId: string, version: string): VersionRow | null {
    const key = JSON.stringify([projectId, version]);
    const cached = this.validated.get(key);
    if (cached) {
      // The edit that made a version can be named after it was read. Until it is, that column is read again.
      const found = (cached.row.changeId === null
        ? this.db.prepare("SELECT change_id FROM timeline_versions WHERE project_id = ? AND version = ?").get(projectId, version)
        : this.db.prepare("SELECT 1 FROM timeline_versions WHERE project_id = ? AND version = ?").get(projectId, version)) as
        { change_id?: string | null } | undefined;
      if (found) {
        this.validated.delete(key);
        this.validated.set(key, cached);
        const { author, ...row } = cached.row;
        return { ...row, author: author && { ...author }, changeId: cached.row.changeId ?? found.change_id ?? null,
          timeline: JSON.parse(cached.json) as Timeline };
      }
      this.forget(key);
      return null;
    }
    const raw = this.db
      .prepare("SELECT * FROM timeline_versions WHERE project_id = ? AND version = ?")
      .get(projectId, version) as Raw | undefined;
    if (!raw) return null;
    const row = toRow(raw, Timeline.parse(JSON.parse(raw.json)));
    if (raw.json.length * 2 <= VersionsRepo.entryLimit) this.remember(key, row);
    return row;
  }

  /** Older versions have no stored duration; only those need the full timeline to calculate it. */
  duration(projectId: string, version: string): number | undefined {
    const row = this.db.prepare("SELECT duration FROM timeline_versions WHERE project_id = ? AND version = ?")
      .get(projectId, version) as { duration: number | null } | undefined;
    if (!row) return;
    if (row.duration !== null) return row.duration;
    const saved = this.get(projectId, version);
    return saved ? timelineDuration(saved.timeline) : undefined;
  }

  exists(projectId: string, version: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM timeline_versions WHERE project_id = ? AND version = ?")
      .get(projectId, version);
  }

  /** Whether any version of the project names this file: the working video, one in its history, or one still proposed. */
  usesMedia(projectId: string, mediaId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM timeline_versions WHERE project_id = ? AND instr(json, ?) LIMIT 1")
      .get(projectId, JSON.stringify(mediaId));
  }

  insert(row: VersionRow, validated = false): VersionRow {
    const json = JSON.stringify(row.timeline);
    const result = this.db
      .prepare(
        `INSERT INTO timeline_versions (version, project_id, parent, json, author, change_id, description, created_at, timeline_name, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, version) DO NOTHING`,
      )
      .run(
        row.version,
        row.projectId,
        row.parent,
        json,
        row.author ? JSON.stringify(row.author) : null,
        row.changeId,
        row.description ?? null,
        row.createdAt,
        row.timeline.name,
        timelineDuration(row.timeline),
      );
    if (!result.changes) return this.get(row.projectId, row.version)!;
    if (validated) this.remember(JSON.stringify([row.projectId, row.version]), row, json);
    return row;
  }

  setChangeId(projectId: string, version: string, changeId: string) {
    this.db
      .prepare("UPDATE timeline_versions SET change_id = ? WHERE project_id = ? AND version = ? AND change_id IS NULL")
      .run(changeId, projectId, version);
  }

  links(projectId: string) {
    return this.db.prepare(`SELECT v.version, v.parent, v.change_id AS changeId, v.description, v.created_at AS createdAt,
      json_extract(c.json, '$.revertsVersion') AS revertsVersion
      FROM timeline_versions v LEFT JOIN changes c ON c.id = v.change_id WHERE v.project_id = ?`)
      .all(projectId) as Array<{ version: string; parent: string | null; changeId: string | null; description?: string; createdAt: string; revertsVersion?: string }>;
  }

  summaries(projectId: string, head: string | null): VersionSummary[] {
    const rows = this.db.prepare(`SELECT v.version, v.parent, v.author, v.change_id, v.description, v.created_at, v.timeline_name, v.duration,
      json_extract(c.json, '$.revertsVersion') AS reverts_version
      FROM timeline_versions v LEFT JOIN changes c ON c.id = v.change_id WHERE v.project_id = ? ORDER BY v.created_at DESC, v.rowid DESC`).all(projectId) as Array<
      Omit<Raw, "json" | "project_id"> & { timeline_name: string | null; duration: number | null; reverts_version: string | null }
    >;
    const legacy = rows.filter(r => r.duration === null || r.timeline_name === null);
    if (legacy.length) this.db.transaction(() => {
      const save = this.db.prepare("UPDATE timeline_versions SET timeline_name = ?, duration = ? WHERE project_id = ? AND version = ?");
      for (const row of legacy) {
        const timeline = this.get(projectId, row.version)!.timeline;
        row.timeline_name = timeline.name;
        row.duration = timelineDuration(timeline);
        save.run(row.timeline_name, row.duration, projectId, row.version);
      }
    }, "immediate")();
    return rows.map(r => ({
      revertsVersion: r.reverts_version ?? undefined, version: r.version, parent: r.parent, name: r.timeline_name!, duration: r.duration!,
      author: r.author ? Author.parse(JSON.parse(r.author)) : undefined, changeId: r.change_id,
      description: r.description ?? undefined, createdAt: r.created_at, isHead: r.version === head,
    }));
  }
}
