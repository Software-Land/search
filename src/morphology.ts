/**
 * Preferred public morphology factory. Not intrinsic to SearchEngine.
 * Currently the English implementation: suffix heuristics, repeat collapse,
 * and an optional caller-owned lemma table. No built-in lemma entries.
 */

import { createEnglishPlugin, type EnglishPlugin } from "./text/english.js";
import type { MorphologyOptions } from "./api.js";

/**
 * Preferred public morphology factory.
 * `morphology()` has an empty explicit lemma table.
 * `morphology({ lemmas })` uses only the supplied entries.
 */
export function morphology(options: MorphologyOptions = {}): EnglishPlugin {
  return createEnglishPlugin({ lemmas: options.lemmas });
}
