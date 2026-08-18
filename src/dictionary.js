/**
 * Configured equivalence dictionary. Search logic consumes this generically;
 * Host-specific acronyms are data, not engine code.
 *
 * Entry shape:
 * { key: "tls", expansion: ["transport","layer","security"], aliases: [["..."]] }
 */

/** @param {{ entries?: unknown[] }} [options] */
export function dictionary({ entries = [] } = {}) {
  /** @type {import("./types.js").DictionaryEntry[]} */
  const list = [];
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    if (entry) list.push(entry);
  }
  const byKey = new Map();
  /** @type {import("./types.js").DictionarySequence[]} */
  const sequences = [];

  for (const entry of list) {
    byKey.set(entry.key, entry);
    sequences.push({ entry, tokens: [entry.key], kind: "key" });
    if (entry.expansion.length) {
      sequences.push({ entry, tokens: entry.expansion, kind: "expansion" });
    }
    for (const alias of entry.aliases) {
      sequences.push({ entry, tokens: alias, kind: "alias" });
    }
  }

  sequences.sort((a, b) => b.tokens.length - a.tokens.length);

  return {
    name: "dictionary",
    entries: list,
    byKey,
    sequences,
    lexicon() {
      const words = new Set();
      for (const entry of list) {
        words.add(entry.key);
        for (const w of entry.expansion) words.add(w);
        for (const alias of entry.aliases) {
          for (const w of alias) words.add(w);
        }
      }
      return words;
    },
  };
}

/**
 * @param {unknown} raw
 * @returns {import("./types.js").DictionaryEntry | null}
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("key" in raw) || !raw.key) return null;
  const rec = /** @type {{ key: unknown, expansion?: unknown, aliases?: unknown, primary?: unknown, type?: unknown, provenance?: unknown, confidence?: unknown }} */ (raw);
  const key = String(rec.key).toLowerCase();
  const expansion = Array.isArray(rec.expansion)
    ? rec.expansion.map((w) => String(w).toLowerCase())
    : [];
  const aliases = Array.isArray(rec.aliases)
    ? rec.aliases
        .filter((a) => Array.isArray(a) && a.length)
        .map((a) => a.map((/** @type {unknown} */ w) => String(w).toLowerCase()))
    : [];
  return {
    key,
    expansion,
    aliases,
    primary: rec.primary == null ? null : String(rec.primary),
    type: rec.type == null ? "equivalence" : String(rec.type),
    provenance: rec.provenance == null ? null : String(rec.provenance),
    confidence: rec.confidence == null ? null : Number(rec.confidence),
  };
}

/** @param {Record<string, { exp?: string[], aliases?: string[][], primary?: string | null }> | null | undefined} [acronymMap] */
export function entriesFromAcronymMap(acronymMap) {
  return Object.entries(acronymMap || {}).map(([key, def]) => ({
    key,
    expansion: Array.isArray(def?.exp) ? def.exp : [],
    aliases: Array.isArray(def?.aliases) ? def.aliases : [],
    primary: def?.primary ?? null,
  }));
}
