import {
  tokenize,
  collapseTrailingRepeats,
  levenshtein,
  DEFAULT_STOP,
} from "./text.js";
import { isAllDigitToken, extractDottedSpans } from "./versionForms.js";
import { throwIfAborted } from "./cancel.js";
import { compoundSpellSegment, decodeLeet, salvageContainedTerm } from "./analyzeRepair.js";

/** @param {import("./types.js").SearchPlugin[]} plugins @param {string} token */
function pluginLemma(plugins, token) {
  for (const plugin of plugins) {
    if (typeof plugin.lemma === "function") {
      return plugin.lemma(token);
    }
  }
  return token;
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

/** @param {unknown} token @param {Set<string>} lexicon */
function greedySegment(token, lexicon) {
  const t = String(token || "");
  if (t.length < 8 || t.includes(" ")) return null;
  const parts = [];
  let i = 0;
  while (i < t.length) {
    let matched = null;
    for (let len = Math.min(t.length - i, 24); len >= 3; len--) {
      const slice = t.slice(i, i + len);
      if (lexicon.has(slice)) {
        matched = slice;
        break;
      }
    }
    if (!matched) return null;
    parts.push(matched);
    i += matched.length;
  }
  return parts.length >= 2 ? parts : null;
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

/** @param {import("./types.js").QueryToken[]} tokens @param {import("./types.js").SearchPlugin | null} dict */
function matchDictionarySequences(tokens, dict) {
  if (!dict || !dict.sequences) return [];
  const hits = [];
  const used = new Set();
  const norms = tokens.map((t) => t.normalized);
  for (const seq of dict.sequences) {
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
        if (j === n - 1 && tok !== want && want.startsWith(tok)) lastWasPrefix = true;
      }
      if (!ok) continue;
      for (let j = 0; j < n; j++) used.add(i + j);
      hits.push({
        entry: seq.entry,
        kind: lastWasPrefix ? "partial-expansion" : seq.kind,
        from: i,
        to: i + n,
      });
    }
  }
  return hits;
}

/** @param {import("./types.js").QueryToken[]} tokens @param {import("./types.js").SearchPlugin | null} dict @param {Set<number>} used */
function matchExpansionPrefixes(tokens, dict, used) {
  if (!dict || !dict.sequences) return [];
  const norms = tokens.map((t) => t.normalized);
  const k = norms.length;
  if (k < 2) return [];
  const hits = [];
  for (const seq of dict.sequences) {
    if (seq.kind === "key") continue;
    const n = seq.tokens.length;
    if (n <= k) continue;
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (used.has(j) || norms[j] !== seq.tokens[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (let j = 0; j < k; j++) used.add(j);
    hits.push({
      entry: seq.entry,
      kind: "partial-expansion",
      from: 0,
      to: k,
    });
    break;
  }
  return hits;
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
 * Immutable query analysis. Surface tokens are never discarded; alternatives
 * carry provenance.
 * @param {unknown} rawQuery
 * @param {import("./types.js").AnalyzeOptions} [options]
 * @returns {import("./types.js").AnalyzedQuery}
 */
export function analyzeQuery(rawQuery, { plugins = [], lexicon = [], signal } = {}) {
  throwIfAborted(signal);
  const raw = String(rawQuery ?? "");
  const dict = dictionaryPlugin(plugins);
  const lex = lexiconFrom(plugins, lexicon);
  const dictionaryKeys = dictionaryKeysFrom(plugins);
  const alternatives = [];

  let surface = tokenize(raw);
  if (surface.length === 1) {
    const original = surface[0];
    const segmented = greedySegment(original, lex);
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
    const lemma = pluginLemma(plugins, normalized);
    if (lemma !== normalized) sources.push("morphology");
    return {
      surface: surfaceTok,
      normalized,
      lemma,
      sources,
    };
  });

  const dictHits = matchDictionarySequences(tokens, dict);
  const concepts = [];
  const covered = new Set();
  for (const hit of dictHits) {
    for (let i = hit.from; i < hit.to; i++) covered.add(i);
  }
  const prefixHits = matchExpansionPrefixes(tokens, dict, covered);
  for (const hit of [...dictHits, ...prefixHits]) {
    const forms = formsForEntry(hit.entry);
    concepts.push({
      id: hit.entry.key,
      kind: "acronym",
      forms,
      provenance: hit.kind,
    });
    for (let i = hit.from; i < hit.to; i++) covered.add(i);
  }

  for (let i = 0; i < tokens.length; i++) {
    if (covered.has(i)) continue;
    const tok = tokens[i];
    if (DEFAULT_STOP.has(tok.normalized) && tokens.length > 2) continue;
    if (isAllDigitToken(tok.normalized)) {
      concepts.push({
        id: tok.normalized,
        kind: "number",
        forms: [tok.normalized],
        provenance: "surface",
      });
      continue;
    }
    const forms = new Set([tok.surface, tok.normalized, tok.lemma].filter(Boolean));
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

  return {
    raw,
    originalSurface: tokenize(raw),
    tokens,
    concepts,
    alternatives,
    dottedSpans: dotted,
    stopstripped:
      tokens.length > 2
        ? tokens.filter((t) => !DEFAULT_STOP.has(t.normalized))
        : tokens,
  };
}

/**
 * Conservative typo suggestions against a candidate vocabulary (titles ∪ dictionary).
 * Short alphanumeric literals (s3, h2, k8) are not treated as spelling errors.
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
    if (!best || d < best.distance) best = { form: cand, distance: d, provenance: "edit-distance" };
  }
  if (best) out.push(best);
  return out;
}
