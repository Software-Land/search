import {
  tokenize,
  collapseTrailingRepeats,
  levenshtein,
  DEFAULT_STOP,
  allowPrefixMatch,
} from "./text.js";
import { isAllDigitToken, extractDottedSpans } from "./versionForms.js";
import { throwIfAborted } from "./cancel.js";
import {
  compoundSpellSegment,
  decodeLeet,
  salvageContainedTerm,
  MAX_COMPOUND_REPAIR_TOKEN_LENGTH,
} from "./analyzeRepair.js";
import { canonicalLexicalTokensFromQuery } from "./lexicalNormalize.js";

/** @param {import("./types.js").SearchPlugin[]} plugins @param {string} token */
function pluginLemma(plugins, token) {
  for (const plugin of plugins) {
    if (typeof plugin.lemma === "function") {
      return plugin.lemma(token);
    }
  }
  return token;
}

/**
 * Confident morphology only (explicit lemma table). Suffix-heuristic stems
 * stay on `lemma` and do not rewrite retrieval `normalized`.
 * @param {import("./types.js").SearchPlugin[]} plugins @param {string} token
 */
function pluginCanonicalLemma(plugins, token) {
  for (const plugin of plugins) {
    if (typeof plugin.canonicalLemma === "function") {
      const hit = plugin.canonicalLemma(token);
      if (hit) return hit;
    }
  }
  return null;
}

/** @param {import("./types.js").SearchPlugin[]} plugins */
function dictionaryPlugin(plugins) {
  return plugins.find((p) => p && p.sequences) || null;
}

/** @param {import("./types.js").SearchPlugin[]} plugins */
function synonymPlugin(plugins) {
  return plugins.find((p) => p && typeof p.expand === "function" && p.name === "synonyms") || null;
}

/** @param {import("./types.js").SearchPlugin[]} plugins @param {Iterable<string> | Set<string> | null | undefined} extra */
function lexiconFrom(plugins, extra) {
  const words = new Set(extra || []);
  for (const plugin of plugins) {
    if (typeof plugin.lexicon === "function") {
      for (const w of plugin.lexicon()) words.add(w);
    }
  }
  return words;
}

const MIN_FINAL_PREFIX_LEN = 4;
/** Reject prefix completion when more than this many vocabulary words match; the prefix is too ambiguous to rewrite. */
const MAX_PREFIX_COMPLETIONS = 48;
const MAX_PHRASE_CANONICALS = 12;
/** Prevents a malformed morphology plugin from cycling indefinitely. */
const MAX_LEMMA_FIXED_POINT_ITERS = 4;
/** Bound recursive exact-compound segmentation of a user-controlled token. */
const MAX_COMPOUND_PART_LENGTH = 24;
/** Ambiguous prefix alternatives are explain/provenance only, shortest then lexicographic. */
const MAX_PREFIX_ALTERNATIVES = 4;
const PREFIX_UNIQUE_CONFIDENCE = 0.9;
const PREFIX_AMBIGUOUS_CONFIDENCE = 0.55;

/** @param {unknown} token @param {Set<string>} lexicon */
function segmentExactCompound(token, lexicon) {
  const t = String(token || "");
  if (t.length < 8 || t.length > MAX_COMPOUND_REPAIR_TOKEN_LENGTH || t.includes(" ")) return null;
  if (lexicon.has(t)) return null;
  /** @type {Map<number, string[] | null>} */
  const memo = new Map();
  /** @param {number} i @returns {string[] | null} */
  function walk(i) {
    if (i === t.length) return [];
    if (memo.has(i)) return memo.get(i) ?? null;
    for (let len = Math.min(t.length - i, MAX_COMPOUND_PART_LENGTH); len >= 3; len--) {
      const slice = t.slice(i, i + len);
      if (isAllDigitToken(slice) || !lexicon.has(slice)) continue;
      const rest = walk(i + len);
      if (!rest) continue;
      const parts = [slice, ...rest];
      memo.set(i, parts);
      return parts;
    }
    memo.set(i, null);
    return null;
  }
  const parts = walk(0);
  return parts && parts.length >= 2 ? parts : null;
}

/**
 * @param {string} tok
 * @param {string} want
 * @param {{ isLast?: boolean, allowShortLastPrefix?: boolean }} [opts]
 */
function tokenSatisfiesDictToken(tok, want, { isLast = false, allowShortLastPrefix = false } = {}) {
  if (tok === want) return true;
  if (!want.startsWith(tok)) return false;
  if (isLast && allowShortLastPrefix && tok.length >= 1) return true;
  if (tok.length < 3) return false;
  if (isLast) return true;
  return tok.length / want.length >= 0.5;
}

/**
 * Exact expansion words compare against typed surface, not post-lemma
 * retrieval `normalized`. Otherwise `learning → learn` would fail to match
 * configured `["machine","learning"]`.
 *
 * @param {import("./types.js").QueryToken} tok
 * @param {string} want
 */
function tokenExactDictWord(tok, want) {
  const surface = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (surface === want) return true;
  if (tok.normalized === want && surface === tok.normalized) return true;
  return false;
}

/**
 * Distinct keys for a span. Two or more keys sharing the same exact
 * expansion do not collapse. Insertion order, lexicographic order, and
 * `primary` are not used.
 *
 * @param {import("./types.js").DictionaryEntry[]} entries
 * @returns {string | null}
 */
function uniqueConfiguredKey(entries) {
  const keys = new Set();
  for (const e of entries || []) {
    if (e?.key) keys.add(e.key);
  }
  if (keys.size !== 1) return null;
  return keys.values().next().value;
}

/**
 * @param {import("./types.js").QueryToken[]} tokens
 * @param {import("./types.js").SearchPlugin} dict
 * @param {number} from
 * @param {number} n
 * @returns {import("./types.js").DictionaryEntry[]}
 */
function exactExpansionEntriesAt(tokens, dict, from, n) {
  /** @type {import("./types.js").DictionaryEntry[]} */
  const entries = [];
  const seen = new Set();
  if (!dict?.sequences) return entries;
  for (const seq of dict.sequences) {
    if (seq.kind !== "expansion") continue;
    if (seq.tokens.length !== n) continue;
    const key = seq.entry?.key;
    if (!key || seen.has(key)) continue;
    let exact = true;
    for (let j = 0; j < n; j++) {
      if (!tokenExactDictWord(tokens[from + j], seq.tokens[j])) {
        exact = false;
        break;
      }
    }
    if (!exact) continue;
    seen.add(key);
    entries.push(seq.entry);
  }
  return entries;
}

/**
 * @param {import("./types.js").QueryToken[]} tokens
 * @param {import("./types.js").SearchPlugin} dict
 * @param {number} from
 * @param {number} n
 * @returns {import("./types.js").DictionaryEntry[]}
 */
function expansionPrefixEntriesAt(tokens, dict, from, n) {
  /** @type {import("./types.js").DictionaryEntry[]} */
  const entries = [];
  const seen = new Set();
  if (!dict?.sequences) return entries;
  for (const seq of dict.sequences) {
    if (seq.kind !== "expansion") continue;
    if (seq.tokens.length !== n) continue;
    const key = seq.entry?.key;
    if (!key || seen.has(key)) continue;
    let ok = true;
    for (let j = 0; j < n; j++) {
      const tok = tokens[from + j];
      const want = seq.tokens[j];
      if (tokenExactDictWord(tok, want)) continue;
      const isLast = j === n - 1;
      if (
        isLast &&
        tokenSatisfiesDictToken(tok.normalized, want, { isLast: true, allowShortLastPrefix: true })
      ) {
        continue;
      }
      ok = false;
      break;
    }
    if (!ok) continue;
    seen.add(key);
    entries.push(seq.entry);
  }
  return entries;
}

/**
 * Expansion uniquely owned by one key. Shared expansions do not project.
 *
 * @param {import("./types.js").SearchPlugin | null} dict
 * @param {string} key
 * @returns {string[] | null}
 */
function uniquelyOwnedExpansion(dict, key) {
  const byKey = dict?.byKey;
  if (!byKey) return null;
  const entry = byKey.get(key);
  if (!entry?.expansion?.length) return null;
  const sig = entry.expansion.join("\0");
  let owners = 0;
  for (const other of byKey.values()) {
    if ((other.expansion || []).join("\0") === sig) owners += 1;
  }
  return owners === 1 ? [...entry.expansion] : null;
}

/**
 * Lemmatize configured expansion words with the same morphology rules as
 * typed query tokens, so "machine learning" and a projected "ml" share
 * canonical intent terms such as ["machine","learn"].
 *
 * @param {string[]} expansion
 * @param {import("./types.js").SearchPlugin[]} plugins
 * @returns {import("./types.js").QueryToken[]}
 */
function lemmatizedExpansionTokens(expansion, plugins) {
  /** @type {import("./types.js").QueryToken[]} */
  const out = [];
  for (const word of expansion || []) {
    const w = String(word || "");
    if (!w || isAllDigitToken(w)) continue;
    const lemma = pluginLemma(plugins, w);
    const canonical = pluginCanonicalLemma(plugins, w);
    const sources = ["configured-equivalence", "expansion"];
    let normalized = w;
    if (canonical && canonical !== w) {
      normalized = canonical;
      sources.push("morphology");
    }
    out.push({
      surface: w,
      surfaceNormalized: w,
      normalized,
      lemma: canonical || lemma,
      sources,
    });
  }
  return out;
}

/**
 * Unique exact-key queries inherit the canonical lexical intent of their
 * expansion. Concept identity/provenance stay on the acronym concept.
 * Shared expansions and partial matches are not rewritten.
 *
 * @param {import("./types.js").QueryToken[]} tokens
 * @param {import("./types.js").QueryConcept[]} concepts
 * @param {import("./types.js").SearchPlugin | null} dict
 * @param {import("./types.js").SearchPlugin[]} plugins
 */
function projectUniqueKeyCanonicalIntent(tokens, concepts, dict, plugins) {
  const acronyms = (concepts || []).filter((c) => c.kind === "acronym");
  if (acronyms.length !== 1) return tokens;
  const acr = acronyms[0];
  if (acr.provenance !== "key") return tokens;
  if (tokens.length !== 1 || tokens[0].normalized !== acr.id) return tokens;
  const expansion = uniquelyOwnedExpansion(dict, acr.id);
  if (!expansion) return tokens;
  const projected = lemmatizedExpansionTokens(expansion, plugins);
  return projected.length ? projected : tokens;
}

/** @param {{ kind?: string, tokens?: string[], entry?: { key?: string, expansion?: string[] } }} seq */
function isSingleExpansionWordAliasSequence(seq) {
  if (seq.kind !== "alias") return false;
  const key = seq.entry?.key;
  const expansion = (seq.entry?.expansion || []).filter((f) => f && f !== key && !/^\d+$/.test(f));
  const tokens = seq.tokens || [];
  return expansion.length >= 2 && tokens.length === 1 && expansion.includes(tokens[0]);
}

/** @param {import("./types.js").QueryToken[]} tokens @param {import("./types.js").SearchPlugin | null} dict */
function matchDictionarySequences(tokens, dict) {
  if (!dict || !dict.sequences) return [];
  const hits = [];
  const used = new Set();
  const norms = tokens.map((t) => t.normalized);
  for (const seq of dict.sequences) {
    if (isSingleExpansionWordAliasSequence(seq)) continue;
    const n = seq.tokens.length;
    if (n === 0) continue;
    for (let i = 0; i <= norms.length - n; i++) {
      let ok = true;
      let lastWasPrefix = false;
      for (let j = 0; j < n; j++) {
        if (used.has(i + j)) {
          ok = false;
          break;
        }
        const tok = norms[i + j];
        const want = seq.tokens[j];
        const earlierExact = j === 0 || norms.slice(i, i + j).every((t, k) => t === seq.tokens[k]);
        const allowShortLastPrefix =
          seq.kind !== "key" && n >= 2 && j === n - 1 && earlierExact;
        // Exact keys may match anywhere. Incomplete key prefixes are applied
        // later, and only to the unused final active token.
        if (seq.kind === "key") {
          if (tok === want) continue;
          ok = false;
          break;
        }
        if (tok === seq.entry.key && n === 1) {
          if (tok !== want && !tokenSatisfiesDictToken(tok, want, { isLast: true })) {
            ok = false;
            break;
          }
          continue;
        }
        if (!tokenSatisfiesDictToken(tok, want, { isLast: j === n - 1, allowShortLastPrefix })) {
          ok = false;
          break;
        }
        // Lemma rewrite (learning → learn) must not turn an exact typed
        // expansion into a partial prefix. lastWasPrefix follows the typed
        // surface, not the retrieval `normalized` value.
        if (
          j === n - 1 &&
          tok !== want &&
          want.startsWith(tok) &&
          !tokenExactDictWord(tokens[i + j], want)
        ) {
          lastWasPrefix = true;
        }
      }
      if (!ok) continue;
      if (seq.kind === "expansion") {
        const entries = lastWasPrefix
          ? expansionPrefixEntriesAt(tokens, dict, i, n)
          : exactExpansionEntriesAt(tokens, dict, i, n);
        const key = uniqueConfiguredKey(entries);
        if (!key || key !== seq.entry.key) continue;
      }
      for (let j = 0; j < n; j++) used.add(i + j);
      hits.push({
        entry: seq.entry,
        kind: lastWasPrefix ? "partial-expansion" : seq.kind,
        from: i,
        to: i + n,
        matchedExpansionTokens: n,
        expansionTokenCount: (seq.entry.expansion || []).length,
        expansionCoverage:
          seq.kind === "expansion" || lastWasPrefix
            ? Number((n / Math.max((seq.entry.expansion || []).length, 1)).toFixed(4))
            : seq.kind === "key"
              ? 1
              : undefined,
      });
    }
  }
  return hits;
}

const MIN_EXPANSION_PREFIX_TOKENS = 2;
const MIN_EXPANSION_PREFIX_COVERAGE = 2 / 3;

/**
 * Left-prefix of a longer configured expansion. Does not collapse to the key.
 * Requires ≥2 aligned tokens, coverage ≥ 2/3, a unique best expansion, and
 * that the match start at expansion token 0. The final typed token may be a
 * prefix of the corresponding expansion token.
 *
 * @param {import("./types.js").QueryToken[]} tokens
 * @param {import("./types.js").SearchPlugin | null} dict
 * @param {Set<number>} used
 */
function matchExpansionPrefixes(tokens, dict, used) {
  if (!dict || !dict.sequences) return [];
  const norms = tokens.map((t) => t.normalized);
  const k = norms.length;
  if (k < MIN_EXPANSION_PREFIX_TOKENS) return [];
  /** @type {Array<{ entry: import("./types.js").DictionaryEntry, kind: string, from: number, to: number, matchedExpansionTokens: number, expansionTokenCount: number, expansionCoverage: number }>} */
  const candidates = [];
  const seen = new Set();
  for (const seq of dict.sequences) {
    if (seq.kind !== "expansion") continue;
    const n = seq.tokens.length;
    if (n <= k) continue;
    const key = seq.entry?.key;
    if (!key || seen.has(key)) continue;
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (used.has(j)) {
        ok = false;
        break;
      }
      const tok = norms[j];
      const want = seq.tokens[j];
      const isLast = j === k - 1;
      if (isLast) {
        if (!tokenSatisfiesDictToken(tok, want, { isLast: true, allowShortLastPrefix: true })) {
          ok = false;
          break;
        }
      } else if (tok !== want) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const coverage = k / n;
    if (coverage < MIN_EXPANSION_PREFIX_COVERAGE) continue;
    seen.add(key);
    candidates.push({
      entry: seq.entry,
      kind: "partial-expansion",
      from: 0,
      to: k,
      matchedExpansionTokens: k,
      expansionTokenCount: n,
      expansionCoverage: Number(coverage.toFixed(4)),
    });
  }
  if (!candidates.length) return [];
  candidates.sort(
    (a, b) =>
      b.expansionCoverage - a.expansionCoverage ||
      a.expansionTokenCount - b.expansionTokenCount ||
      String(a.entry.key).localeCompare(String(b.entry.key))
  );
  const best = candidates[0].expansionCoverage;
  const top = candidates.filter((c) => c.expansionCoverage === best);
  if (top.length !== 1) return [];
  const hit = top[0];
  for (let j = hit.from; j < hit.to; j++) used.add(j);
  return [hit];
}

/**
 * Incomplete configured-key prefix of the unused final active query token.
 * Exact keys already matched anywhere in matchDictionarySequences.
 *
 * @param {import("./types.js").QueryToken[]} tokens
 * @param {import("./types.js").SearchPlugin | null} dict
 * @param {Set<number>} used
 */
function matchFinalActiveKeyPrefix(tokens, dict, used) {
  if (!dict || !dict.sequences) return [];
  const norms = tokens.map((t) => t.normalized);
  if (!norms.length) return [];
  const i = norms.length - 1;
  if (used.has(i)) return [];
  const tok = norms[i];
  const candidates = [];
  const seen = new Set();
  for (const seq of dict.sequences) {
    if (seq.kind !== "key") continue;
    if (seq.tokens.length !== 1) continue;
    const key = seq.entry?.key;
    if (!key || seen.has(key)) continue;
    const want = seq.tokens[0];
    if (tok === want) continue;
    if (!tokenSatisfiesDictToken(tok, want, { isLast: true })) continue;
    seen.add(key);
    candidates.push(seq.entry);
  }
  if (candidates.length !== 1) return [];
  const entry = candidates[0];
  used.add(i);
  const expansionLen = Math.max((entry.expansion || []).length, 1);
  return [
    {
      entry,
      kind: "partial-expansion",
      from: i,
      to: i + 1,
      matchedExpansionTokens: 1,
      expansionTokenCount: expansionLen,
      expansionCoverage: Number((1 / expansionLen).toFixed(4)),
    },
  ];
}

/** @param {import("./types.js").DictionaryEntry} entry */
function formsForEntry(entry) {
  const forms = new Set([entry.key, ...entry.expansion]);
  for (const alias of entry.aliases) {
    for (const w of alias) forms.add(w);
  }
  return [...forms];
}

/** @param {unknown} token @param {Iterable<string>} lex */
function isPrefixOfVocabulary(token, lex) {
  const t = String(token || "");
  if (t.length < 4) return false;
  for (const w of lex) {
    if (typeof w === "string" && w.length > t.length && w.startsWith(t)) return true;
  }
  return false;
}

/** @param {unknown} word */
function isPlausibleCompletionToken(word) {
  return typeof word === "string" && /^[a-z]+$/.test(word);
}

/**
 * Apply the morphology plugin until it stabilizes (learning → learn).
 * Bounded so a malformed plugin that cycles cannot loop forever.
 * @param {(t: string) => string} lemmaFn
 * @param {unknown} token
 */
function lemmaFixedPoint(lemmaFn, token) {
  let cur = String(token || "");
  for (let i = 0; i < MAX_LEMMA_FIXED_POINT_ITERS; i += 1) {
    const next = lemmaFn(cur) || cur;
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/**
 * Surface completions of an incomplete FINAL query token.
 * Stops once overflow of MAX_PREFIX_COMPLETIONS is proven; the prefix is then
 * too ambiguous to rewrite.
 * @param {string} prefix
 * @param {Set<string>} vocab
 */
function prefixCompletions(prefix, vocab) {
  const t = String(prefix || "");
  if (t.length < MIN_FINAL_PREFIX_LEN) return [];
  if (isAllDigitToken(t) || /\d/.test(t)) return [];
  if (DEFAULT_STOP.has(t)) return [];
  const out = [];
  for (const w of vocab) {
    if (!isPlausibleCompletionToken(w)) continue;
    if (w.length <= t.length) continue;
    if (!allowPrefixMatch(t, w)) continue;
    out.push(w);
    if (out.length > MAX_PREFIX_COMPLETIONS) return [];
  }
  out.sort();
  return out;
}

/**
 * Complete only the last active token: prefix → vocabulary word → morphology.
 * Unique canonical lemma rewrites the final token's retrieval `normalized`
 * value. Typed surface, completedToken, and prefixCompletion stay for explain.
 * Ambiguous completions do not rewrite the query.
 *
 * @param {import("./types.js").QueryToken[]} tokens
 * @param {Set<string>} vocab
 * @param {(token: string) => string} lemmaFn
 * @returns {{ tokens: import("./types.js").QueryToken[], prefixCompletion: import("./types.js").PrefixCompletion | null }}
 */
function applyFinalTokenPrefixCompletion(tokens, vocab, lemmaFn) {
  if (!tokens.length) return { tokens, prefixCompletion: null };
  const last = tokens[tokens.length - 1];
  if (!last) return { tokens, prefixCompletion: null };
  const typed = last.surfaceNormalized || last.normalized;
  // Complete typed/repaired forms are not prefixes of their lemma. Unique
  // prefix stubs still complete from the typed stub, not the canonical rewrite.
  if (vocab.has(typed) || vocab.has(last.normalized)) return { tokens, prefixCompletion: null };
  if (last.sources.includes("typo-correction") || last.sources.includes("leet-decode")) {
    return { tokens, prefixCompletion: null };
  }
  const completions = prefixCompletions(typed, vocab);
  if (!completions.length) return { tokens, prefixCompletion: null };
  /** @type {Map<string, string[]>} */
  const byCanon = new Map();
  for (const word of completions) {
    const canon = lemmaFixedPoint(lemmaFn, word);
    if (!byCanon.has(canon)) byCanon.set(canon, []);
    byCanon.get(canon)?.push(word);
  }
  const canonicalTokens = [...byCanon.keys()].sort();
  if (!canonicalTokens.length) return { tokens, prefixCompletion: null };
  const unique = canonicalTokens.length === 1;
  /** @type {string | null} */
  let completedToken = null;
  /** @type {string | null} */
  let canonicalToken = null;
  let nextTokens = tokens;
  if (unique) {
    canonicalToken = canonicalTokens[0];
    const group = [...(byCanon.get(canonicalToken) || [])].sort((a, b) =>
      a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0
    );
    completedToken = group[0] || canonicalToken;
    const sources = last.sources.includes("final-token-prefix")
      ? last.sources
      : [...last.sources, "final-token-prefix"];
    nextTokens = [
      ...tokens.slice(0, -1),
      { ...last, normalized: canonicalToken, lemma: canonicalToken, completedToken, sources },
    ];
  }
  return {
    tokens: nextTokens,
    prefixCompletion: {
      activePrefix: typed,
      completedToken,
      canonicalToken,
      completedTokens: completions,
      canonicalTokens: canonicalTokens.slice(0, MAX_PHRASE_CANONICALS),
      source: "final-token-prefix",
      ambiguous: !unique,
    },
  };
}

/** @param {import("./types.js").SearchPlugin[]} plugins */
function dictionaryKeysFrom(plugins) {
  const keys = new Set();
  const dict = dictionaryPlugin(plugins);
  if (dict?.byKey) {
    for (const k of dict.byKey.keys()) keys.add(k);
  }
  return keys;
}

/**
 * Query analysis. Surface tokens are never discarded; alternatives carry
 * provenance. The final token may be replaced (not mutated) when a unique
 * prefix completion exists.
 * @param {unknown} rawQuery
 * @param {import("./types.js").AnalyzeOptions} [options]
 * @returns {import("./types.js").AnalyzedQuery}
 */
export function analyzeQuery(rawQuery, { plugins = [], lexicon = [], prefixLexicon, signal } = {}) {
  throwIfAborted(signal);
  const raw = String(rawQuery ?? "");
  const dict = dictionaryPlugin(plugins);
  const lex = lexiconFrom(plugins, lexicon);
  const prefixLex = prefixLexicon == null ? lex : lexiconFrom(plugins, prefixLexicon);
  const dictionaryKeys = dictionaryKeysFrom(plugins);
  const alternatives = [];

  let surface = tokenize(raw);
  if (surface.length === 1) {
    const original = surface[0];
    const segmented = segmentExactCompound(original, lex);
    if (segmented) {
      surface = segmented;
      alternatives.push({ tokens: segmented, source: "compound-segment", confidence: 1 });
    } else {
      const spelled = compoundSpellSegment(original, lex, { signal });
      if (spelled) {
        surface = spelled.tokens;
        alternatives.push({ tokens: spelled.tokens, source: spelled.source, confidence: 0.8 });
      } else {
        const salvaged = salvageContainedTerm(original, { lexicon: lex, dictionaryKeys, signal });
        if (salvaged) {
          surface = salvaged.tokens;
          alternatives.push({ tokens: salvaged.tokens, source: salvaged.source, confidence: 0.7 });
        }
      }
    }
  }

  throwIfAborted(signal);

  /** @type {import("./types.js").QueryToken[]} */
  const tokens = surface.map((surfaceTok) => {
    const collapsed = collapseTrailingRepeats(surfaceTok);
    const sources = ["surface"];
    if (collapsed !== surfaceTok) sources.push("repeat-collapse");
    let normalized = collapsed;
    const leet = decodeLeet(collapsed);
    if (leet && lex.has(leet)) {
      normalized = leet;
      sources.push("leet-decode");
      alternatives.push({ tokens: [leet], source: "leet-decode", confidence: 0.75 });
    }
    const typoHits =
      lex.has(normalized) || isPrefixOfVocabulary(normalized, lex)
        ? []
        : suggestTypoForms(normalized, lex, { signal });
    const edit = typoHits.find((s) => s.provenance === "edit-distance" && lex.has(s.form));
    if (edit) {
      alternatives.push({
        tokens: [edit.form],
        source: "typo-correction",
        confidence: edit.distance <= 1 ? 0.85 : 0.6,
      });
      normalized = edit.form;
      sources.push("typo-correction");
    }
    // Repaired form before lemma / unique-prefix rewrite. Retrieval uses the
    // canonical `normalized` value; ranking can still see what was typed.
    const surfaceNormalized = normalized;
    const lemma = pluginLemma(plugins, normalized);
    const canonical = pluginCanonicalLemma(plugins, normalized);
    if (canonical && canonical !== normalized) {
      normalized = canonical;
      sources.push("morphology");
    } else if (lemma !== normalized) {
      sources.push("morphology");
    }
    return {
      surface: surfaceTok,
      surfaceNormalized,
      normalized,
      lemma: canonical || lemma,
      sources,
    };
  });

  const applied = applyFinalTokenPrefixCompletion(tokens, prefixLex, (tok) =>
    pluginLemma(plugins, tok)
  );
  const analyzedTokens = applied.tokens;
  const prefixCompletion = applied.prefixCompletion;
  if (prefixCompletion) {
    const preceding = analyzedTokens.slice(0, -1).map((t) => t.normalized);
    if (prefixCompletion.completedToken) {
      alternatives.push({
        tokens: [...preceding, prefixCompletion.completedToken],
        source: "final-token-prefix",
        confidence: PREFIX_UNIQUE_CONFIDENCE,
      });
    } else {
      const ranked = [...prefixCompletion.completedTokens].sort((a, b) =>
        a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0
      );
      for (const word of ranked.slice(0, MAX_PREFIX_ALTERNATIVES)) {
        alternatives.push({
          tokens: [...preceding, word],
          source: "final-token-prefix",
          confidence: PREFIX_AMBIGUOUS_CONFIDENCE,
        });
      }
    }
  }

  const dictHits = matchDictionarySequences(analyzedTokens, dict);
  /** @type {import("./types.js").QueryConcept[]} */
  const concepts = [];
  const dictionaryOccupiedIndexes = new Set();
  for (const hit of dictHits) {
    for (let i = hit.from; i < hit.to; i++) dictionaryOccupiedIndexes.add(i);
  }
  const prefixHits = matchExpansionPrefixes(analyzedTokens, dict, dictionaryOccupiedIndexes);
  const keyPrefixHits = matchFinalActiveKeyPrefix(analyzedTokens, dict, dictionaryOccupiedIndexes);
  const covered = new Set();
  for (const hit of [...dictHits, ...prefixHits, ...keyPrefixHits]) {
    const forms = formsForEntry(hit.entry);
    concepts.push({
      id: hit.entry.key,
      kind: "acronym",
      forms,
      expansion: [...hit.entry.expansion],
      aliases: hit.entry.aliases.map((a) => [...a]),
      provenance: hit.kind,
      matchedExpansionTokens: hit.matchedExpansionTokens,
      expansionTokenCount: hit.expansionTokenCount,
      expansionCoverage: hit.expansionCoverage,
    });
    // Matched dictionary spans occupy one canonical concept. Tokens outside
    // the span (unmatched surface terms) remain ordinary term concepts.
    if (
      hit.kind === "key" ||
      hit.kind === "alias" ||
      hit.kind === "expansion" ||
      hit.kind === "partial-expansion"
    ) {
      for (let i = hit.from; i < hit.to; i++) covered.add(i);
    }
  }

  for (let i = 0; i < analyzedTokens.length; i++) {
    if (covered.has(i)) continue;
    const tok = analyzedTokens[i];
    if (DEFAULT_STOP.has(tok.normalized) && analyzedTokens.length > 2) continue;
    if (isAllDigitToken(tok.normalized)) {
      concepts.push({
        id: tok.normalized,
        kind: "number",
        forms: [tok.normalized],
        provenance: "surface",
      });
      continue;
    }
    const forms = new Set(
      [tok.surface, tok.surfaceNormalized, tok.normalized, tok.lemma, tok.completedToken].filter(
        /** @type {(v: unknown) => v is string} */ (v) => typeof v === "string" && v.length > 0
      )
    );
    const syn = synonymPlugin(plugins);
    let provenance = tok.sources.includes("morphology") ? "morphology" : "surface";
    if (syn && typeof syn.expand === "function") {
      for (const alt of syn.expand(tok.normalized).concat(syn.expand(tok.lemma))) {
        if (alt.form) forms.add(alt.form);
        provenance = provenance === "surface" ? "synonym" : provenance;
      }
    }
    concepts.push({
      id: tok.lemma || tok.normalized,
      kind: "term",
      forms: [...forms],
      provenance,
    });
  }

  const dotted = extractDottedSpans(raw);
  throwIfAborted(signal);

  const intentTokens = projectUniqueKeyCanonicalIntent(analyzedTokens, concepts, dict, plugins);
  const lexicalPhraseTokens = canonicalLexicalTokensFromQuery(intentTokens);

  return {
    raw,
    originalSurface: tokenize(raw),
    tokens: intentTokens,
    concepts,
    alternatives,
    dottedSpans: dotted,
    prefixCompletion,
    lexicalTokens: intentTokens,
    lexicalPhraseTokens,
    lexicalPhraseKey: lexicalPhraseTokens.join(" "),
    stopstripped:
      intentTokens.length > 2
        ? intentTokens.filter((t) => !DEFAULT_STOP.has(t.normalized))
        : intentTokens,
  };
}

/**
 * Conservative typo suggestions against a candidate vocabulary (titles ∪ dictionary).
 * Short alphanumeric literals (s3, h2, k8) are not treated as spelling errors.
 * Equal-distance edit candidates keep the lexicographically smaller form so the
 * choice does not depend on Set/corpus insertion order or document ids.
 * @param {unknown} token
 * @param {Iterable<string> | Set<string> | null | undefined} candidateSet
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {import("./types.js").TypoSuggestion[]}
 */
export function suggestTypoForms(token, candidateSet, { signal } = {}) {
  const t = String(token || "");
  if (t.length < 5 || isAllDigitToken(t)) return [];
  if (/\d/.test(t) && t.length < 6) return [];
  const collapsed = collapseTrailingRepeats(t);
  const out = [];
  if (collapsed !== t) out.push({ form: collapsed, distance: 1, provenance: "repeat-collapse" });
  let best = null;
  let i = 0;
  for (const cand of candidateSet || []) {
    if ((i++ & 63) === 0) throwIfAborted(signal);
    if (typeof cand !== "string") continue;
    if (Math.abs(cand.length - collapsed.length) > 2) continue;
    const d = levenshtein(collapsed, cand);
    if (d === 0 || d > 2) continue;
    if (!best || d < best.distance || (d === best.distance && cand < best.form)) {
      best = { form: cand, distance: d, provenance: "edit-distance" };
    }
  }
  if (best) out.push(best);
  return out;
}
