/** A phrase that plays, and plays again a moment later: `length` words from `at`, said again from `next`. */
export interface Restart { at: number; length: number; next: number }

/** How long after the first saying ends the second may begin, in seconds and in words said between them. */
export const RESTART_WITHIN_SECONDS = 12, RESTART_WITHIN_WORDS = 12;

/**
 * Phrases said twice within a moment, in playback order: a restart ("there's this like white, I don't know what that
 * is, there's this like white stuff"), a retake left beside the take that replaced it, or a deliberate parallel
 * ("we have Muse Wonder … we have Muse Wonderful"). Which it is takes the sentence to tell, so this only locates
 * them. An immediate word-for-word repeat is one of them, with nothing said between.
 *
 * Three words or more, or two with at most one word between: a shorter match is ordinary speech ("you can … you can").
 * Each word starts at most one phrase, and a third saying pairs with the second.
 */
export function findRestarts(tokens: readonly string[], starts: readonly number[], ends: readonly number[]): Restart[] {
  const found: Restart[] = [];
  const n = tokens.length;
  for (let i = 0; i < n - 1;) {
    let best: Restart | undefined;
    if (tokens[i]) {
      for (let j = i + 2; j < n && j <= i + 2 * RESTART_WITHIN_WORDS + 2; j++) {
        if (tokens[j] !== tokens[i]) continue;
        let length = 0;
        while (i + length < j && j + length < n && tokens[i + length] && tokens[i + length] === tokens[j + length]) length++;
        const between = j - (i + length);
        if (between > RESTART_WITHIN_WORDS || starts[j]! - ends[i + length - 1]! > RESTART_WITHIN_SECONDS) continue;
        const distinct = new Set(tokens.slice(i, i + length)).size;
        if (!(length >= 3 && distinct >= 2) && !(length === 2 && distinct === 2 && between <= 1)) continue;
        if (!best || length > best.length) best = { at: i, length, next: j };
      }
    }
    if (best) { found.push(best); i = best.next; }
    else i++;
  }
  return found;
}
