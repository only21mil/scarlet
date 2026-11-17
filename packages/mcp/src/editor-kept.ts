import type { KeptEdit } from "@scarlet/shared";

const MAX_LISTED = 12;
const quote = (text: string) => `“${text.replace(/[.!?]*$/, "")}”`;

/**
 * The flagged edits the editor kept that this run hasn't heard of yet, as a note on a tool's result. A run doesn't see
 * the editor's window: a pass saved the video twice more after the editor kept a hold it had flagged, and flagged it
 * again in each save, so the editor was asked about it three times (2026-11-16). `heard` is updated.
 */
export function keptEditsNote(kept: readonly KeptEdit[], heard: Set<string>): string | undefined {
  const fresh = kept.filter(edit => edit.check && !heard.has(keyOf(edit)));
  for (const edit of fresh) heard.add(keyOf(edit));
  if (!fresh.length) return undefined;
  const lines = fresh.slice(0, MAX_LISTED).map(edit => {
    const place = edit.place ? ` at ${edit.place.range.start.toFixed(1)}–${edit.place.range.end.toFixed(1)} s on version ${edit.place.version}` : "";
    return `- ${quote(edit.label)} (${edit.changeId}, edit ${edit.spot})${place}. You flagged: ${quote(edit.check!)}.`;
  });
  if (fresh.length > MAX_LISTED) lines.push(`- and ${fresh.length - MAX_LISTED} more.`);
  return [`The editor kept ${fresh.length === 1 ? "this flagged edit" : "these flagged edits"} after reading your reason to look, which settles it. ` +
    "When you save or list the edit again, leave its check off, unless you change the edit or find a different problem there:", ...lines].join("\n");
}

const keyOf = (edit: KeptEdit) => `${edit.changeId}/${edit.spot}/${edit.at}`;
