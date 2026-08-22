/**
 * Preferred public morphology factory. Not intrinsic to SearchEngine.
 * Currently the English implementation (suffix heuristics plus an optional lemma map).
 */

import { createEnglishPlugin, type EnglishPlugin } from "./english.js";
import type { MorphologyOptions } from "./api.js";

/**
 * Preferred public morphology factory. Optional `lemmas` augment the built-in table.
 */
export function morphology(options: MorphologyOptions = {}): EnglishPlugin {
  return createEnglishPlugin({ lemmas: options.lemmas });
}
