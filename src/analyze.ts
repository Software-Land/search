import {
  tokenize,
  collapseTrailingRepeats,
  levenshtein,
  DEFAULT_STOP,
  allowPrefixMatch,
  spokenSignificantSymbolTokens,
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
import { bindMorphologyDerivedEquivalences } from "./synonyms.js";
import {
  additionalConfiguredConceptAliases,
  canonicalConfiguredConceptForm,
} from "./configuredAuthoring.js";
import {
  resolveConfiguredPrefixSpans,
  resolveConfiguredSequence,
  resolveConfiguredSpans,
  tokenAlignsConfiguredKey,
} from "./configuredSequence.js";
import type {
  AnalyzedQuery,
  AnalyzeOptions,
  ConfiguredConcept,
  ConfiguredPrefixSpan,
  ConfiguredSequenceIntent,
  ConfiguredSpan,
  ContextualCompletion,
  PrefixCompletion,
  QueryAlternative,
  QueryConcept,
  QueryToken,
  SearchPlugin,
  StandaloneRecall,
  TopicalRecall,
  TypoSuggestion,
} from "./types.js";

function pluginLemma(plugins: SearchPlugin[], token: string) {
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
 */
function pluginCanonicalLemma(plugins: SearchPlugin[], token: string) {
  for (const plugin of plugins) {
    if (typeof plugin.canonicalLemma === "function") {
      const hit = plugin.canonicalLemma(token);
      if (hit) return hit;
    }
  }
  return null;
}

function findConfiguredConceptPlugin(plugins: SearchPlugin[]) {
  return plugins.find((p) => p && p.sequences) || null;
}

const STANDALONE_RECALL_BLOCKED_SOURCES = new Set([
  "typo-correction",
  "leet-decode",
  "repeat-collapse",
  "final-token-prefix",
  "contextual-completion",
]);

function resolveStandaloneRecall(
  tokens: QueryToken[],
  prefixCompletion: PrefixCompletion | null | undefined,
  configuredSequenceIntent: ConfiguredSequenceIntent | null,
  concepts: QueryConcept[],
  configured: SearchPlugin | null
): StandaloneRecall | null {
  if (!configured || tokens.length !== 1) return null;
  if (configuredSequenceIntent?.key) return null;
  if (concepts.some((c) => c.kind === "configured-concept")) return null;
  if (prefixCompletion) return null;
  const tok = tokens[0];
  if (tok.completedToken) return null;
  if ((tok.sources || []).some((source) => STANDALONE_RECALL_BLOCKED_SOURCES.has(source))) return null;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (!typed || typed !== tok.normalized) return null;
  const key = configured.standaloneRecallByToken?.get(typed);
  if (!key) return null;
  const concept = configured.byKey?.get(key);
  if (!concept || concept.key !== key) return null;
  return {
    key: concept.key,
    sourceToken: typed,
    expansion: [...canonicalConfiguredConceptForm(concept)],
    aliases: additionalConfiguredConceptAliases(concept).map((alias) => [...alias]),
    forms: formsForConfiguredConcept(concept),
  };
}

function topicalRecallForKey(key: string | null | undefined, configured: SearchPlugin | null): TopicalRecall | null {
  if (!key || !configured) return null;
  const forms = configured.topicalRecallByKey?.get(key);
  if (!Array.isArray(forms) || !forms.length) return null;
  return {
    key,
    forms: forms.map((form) => [...form]),
  };
}

function uniqueStopRemainderSpanKey(
  tokens: QueryToken[],
  spans: Array<{ key: string; start: number; end: number }>
): string | null {
  const keys = new Set(spans.map((span) => span.key));
  if (keys.size !== 1) return null;
  const occupied = new Set<number>();
  for (const span of spans) {
    for (let i = span.start; i < span.end; i++) occupied.add(i);
  }
  for (let i = 0; i < tokens.length; i++) {
    if (occupied.has(i)) continue;
    if (!DEFAULT_STOP.has(tokens[i].normalized)) return null;
  }
  return [...keys][0];
}

/**
 * Occupy one unique incomplete configured window. Remainder tokens must
 * already be DEFAULT_STOP. Does not set configuredSequenceIntent or topical
 * recall. Exact spans and whole-query intent keep their existing paths.
 * One-token first-expansion prefixes may occupy when the longest expansion
 * is unique.
 */
function attachConfiguredPrefixSpanConcept(
  concepts: QueryConcept[],
  covered: Set<number>,
  tokens: QueryToken[],
  configured: SearchPlugin | null,
  configuredSequenceIntent: ConfiguredSequenceIntent | null,
  exactSpans: ConfiguredSpan[]
): ConfiguredPrefixSpan[] {
  if (configuredSequenceIntent?.key || !configured) return [];
  if (exactSpans.length) return [];
  const spans = resolveConfiguredPrefixSpans(tokens, configured);
  if (spans.length !== 1) return [];
  const span = spans[0];
  if (uniqueStopRemainderSpanKey(tokens, [span]) !== span.key) return [];
  if (concepts.some((c) => c.kind === "configured-concept" && c.id !== span.key)) return [];
  const compiled = configured.byKey?.get(span.key);
  if (!compiled?.key) return [];
  const tokenCount = span.end - span.start;
  const canonical = canonicalConfiguredConceptForm(compiled);
  const concept = {
    id: compiled.key,
    kind: "configured-concept",
    forms: formsForConfiguredConcept(compiled),
    expansion: [...canonical],
    aliases: additionalConfiguredConceptAliases(compiled).map((a) => [...a]),
    provenance: provenanceForSequenceKinds(span.matchedKinds, true),
    matchedExpansionTokens: tokenCount,
    expansionTokenCount: canonical.length,
    expansionCoverage: Number((tokenCount / Math.max(canonical.length, 1)).toFixed(4)),
  };
  const existing = concepts.find((c) => c.kind === "configured-concept" && c.id === span.key);
  if (existing) Object.assign(existing, concept);
  else concepts.push(concept);
  for (let i = span.start; i < span.end; i++) covered.add(i);
  return [span];
}

function synonymPlugin(plugins: SearchPlugin[]) {
  return plugins.find((p) => p && typeof p.expand === "function" && p.name === "synonyms") || null;
}

function uniqueConfiguredSearchEquivalenceSource(
  configuredSequenceIntent: { key?: string } | null | undefined,
  configuredSpans: Array<{ key: string }> | undefined,
  configuredPrefixSpans: Array<{ key: string }> | undefined
): string | null {
  const sequenceKey = configuredSequenceIntent?.key;
  if (sequenceKey) return sequenceKey;
  const keys = new Set<string>();
  for (const span of configuredSpans || []) {
    if (span?.key) keys.add(span.key);
  }
  for (const span of configuredPrefixSpans || []) {
    if (span?.key) keys.add(span.key);
  }
  if (keys.size === 1) return [...keys][0];
  return null;
}

function admitSearchEquivalenceTargets(
  syn: SearchPlugin,
  source: string,
  seenPairs: Set<string>,
  pairs: Array<{ source: string; target: string }>
) {
  if (!source || typeof syn.expand !== "function") return;
  for (const alt of syn.expand(source)) {
    const target = String(alt?.form || "");
    if (!target) continue;
    const pairKey = `${source}\t${target}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    pairs.push({ source, target });
  }
}

/**
 * Additive one-hop synonym recall after configured occupancy.
 * Lookup uses accepted configured/phrase/uncovered semantics only.
 * Does not rewrite tokens, lexical intent, or configured identity.
 */
function attachSearchEquivalenceRecall(
  query: {
    configuredSequenceIntent?: { key?: string } | null;
    configuredSpans?: Array<{ key: string }>;
    configuredPrefixSpans?: Array<{ key: string }>;
    lexicalPhraseKey?: string;
    concepts: QueryConcept[];
    equivalentRecall?: Array<{ source: string; target: string }>;
  },
  analyzedTokens: QueryToken[],
  covered: Set<number>,
  plugins: SearchPlugin[]
) {
  const syn = synonymPlugin(plugins);
  if (!syn || typeof syn.expand !== "function") return;
  const pairs: Array<{ source: string; target: string }> = [];
  const seenPairs = new Set<string>();
  const configured = uniqueConfiguredSearchEquivalenceSource(
    query.configuredSequenceIntent,
    query.configuredSpans,
    query.configuredPrefixSpans
  );
  if (configured) admitSearchEquivalenceTargets(syn, configured, seenPairs, pairs);
  const phraseKey = query.lexicalPhraseKey;
  if (phraseKey) admitSearchEquivalenceTargets(syn, phraseKey, seenPairs, pairs);
  for (let i = 0; i < analyzedTokens.length; i++) {
    if (covered.has(i)) continue;
    const tok = analyzedTokens[i];
    if (DEFAULT_STOP.has(tok.normalized) && analyzedTokens.length > 2) continue;
    if (isAllDigitToken(tok.normalized)) continue;
    admitSearchEquivalenceTargets(syn, tok.normalized, seenPairs, pairs);
    if (tok.lemma && tok.lemma !== tok.normalized) {
      admitSearchEquivalenceTargets(syn, tok.lemma, seenPairs, pairs);
    }
  }
  if (!pairs.length) return;
  pairs.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const existingForms = new Set<string>();
  for (const concept of query.concepts) {
    for (const form of concept.forms || []) existingForms.add(form);
  }
  for (const pair of pairs) {
    if (existingForms.has(pair.target)) continue;
    query.concepts.push({
      id: pair.target,
      kind: "term",
      forms: [pair.target],
      provenance: "synonym",
    });
    existingForms.add(pair.target);
  }
  query.equivalentRecall = pairs;
}

function lexiconFrom(plugins: SearchPlugin[], extra: Iterable<string> | Set<string> | null | undefined) {
  const words = new Set(extra || []);
  for (const plugin of plugins) {
    if (typeof plugin.lexicon === "function") {
      for (const w of plugin.lexicon()) words.add(w);
    }
  }
  return words;
}

/** Typo candidates stay length ≥ 5, matching `suggestTypoForms` and SearchEngine. */
const MIN_SPELLING_KEY_LENGTH = 5;

/**
 * Lemma-table keys join typo candidate generation only. They are not merged
 * into the title/configured-concept lexicon used for exact compound segmentation or
 * final-token prefix completion, so legitimate prefixes stay prefixes.
 *
 * Complexity: one bounded pass over each morphology table (site lemmas are a
 * fixed compiled map, not a document scan). `suggestTypoForms` still scans
 * the resulting candidate set with length-band ±2 and edit distance ≤ 2.
 */
function spellingLexiconFrom(plugins: SearchPlugin[], base: Set<string>) {
  const words = new Set(base);
  for (const plugin of plugins) {
    if (typeof plugin.lemmaTableKeys !== "function") continue;
    for (const key of plugin.lemmaTableKeys()) {
      if (typeof key === "string" && key.length >= MIN_SPELLING_KEY_LENGTH) words.add(key);
    }
  }
  return words;
}

/**
 * Exact one-token query forms authored as configured lexical intent.
 * Multi-token configured expansion words and synonym targets are deliberately
 * excluded: they are recall forms, not independently authored query keys.
 * A complete one-token expansion is itself an explicit configured query form.
 */
const explicitQueryIntentKeyCache = new WeakMap<object, Set<string>>();

function exactExplicitQueryIntentKeys(plugins: SearchPlugin[]): Set<string> {
  const keys = new Set<string>();

  for (const plugin of plugins) {
    if (plugin && typeof plugin === "object") {
      const cached = explicitQueryIntentKeyCache.get(plugin);
      if (cached) {
        for (const key of cached) keys.add(key);
        continue;
      }
      const pluginKeys = new Set<string>();
      if (plugin.name === "synonyms" && plugin.lookup instanceof Map) {
        for (const source of plugin.lookup.keys()) {
          const tokens = tokenize(source);
          if (tokens.length === 1) pluginKeys.add(tokens[0]);
        }
      }
      for (const sequence of plugin.sequences || []) {
        if (!sequence?.tokens?.length) continue;
        if (
          sequence.kind === "key" ||
          sequence.kind === "alias" ||
          (sequence.kind === "expansion" && sequence.tokens.length === 1)
        ) {
          const tokens = tokenize(sequence.tokens.join(" "));
          if (tokens.length === 1) pluginKeys.add(tokens[0]);
        }
      }
      explicitQueryIntentKeyCache.set(plugin, pluginKeys);
      for (const key of pluginKeys) keys.add(key);
    }
  }
  return keys;
}

export { exactExplicitQueryIntentKeys };

/**
 * Unknown-only repair gate. Known vocabulary, configured keys, confident
 * morphology, and title/configured-concept prefixes must not be rewritten here.
 */
function isProtectedFromUnknownRepair(
  token: string,
  lex: Set<string>,
  configuredConceptKeys: Set<string>,
  explicitQueryIntentKeys: Set<string>,
  plugins: SearchPlugin[]
) {
  if (lex.has(token) || configuredConceptKeys.has(token) || explicitQueryIntentKeys.has(token)) return true;
  if (pluginCanonicalLemma(plugins, token)) return true;
  if (isPrefixOfVocabulary(token, lex)) return true;
  return false;
}

function repairUnknownExactCompounds(
  surface: string[],
  lex: Set<string>,
  configuredConceptKeys: Set<string>,
  explicitQueryIntentKeys: Set<string>,
  plugins: SearchPlugin[],
  alternatives: QueryAlternative[]
) {
  const out: string[] = [];
  for (const tok of surface) {
    if (isProtectedFromUnknownRepair(tok, lex, configuredConceptKeys, explicitQueryIntentKeys, plugins)) {
      out.push(tok);
      continue;
    }
    const segmented = segmentExactCompound(tok, lex);
    if (segmented) {
      out.push(...segmented);
      alternatives.push({ tokens: segmented, source: "compound-segment", confidence: 1 });
    } else {
      out.push(tok);
    }
  }
  return out;
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

function segmentExactCompound(token: unknown, lexicon: Set<string>) {
  const t = String(token || "");
  if (t.length < 8 || t.length > MAX_COMPOUND_REPAIR_TOKEN_LENGTH || t.includes(" ")) return null;
  if (lexicon.has(t)) return null;
  const memo = new Map<number, string[] | null>();
  function walk(i: number): string[] | null {
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

function tokenSatisfiesConfiguredToken(
  tok: string,
  want: string,
  { isLast = false, allowShortLastPrefix = false }: { isLast?: boolean; allowShortLastPrefix?: boolean } = {}
) {
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
 */
function tokenExactConfiguredWord(tok: QueryToken, want: string) {
  const surface = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (surface === want) return true;
  if (tok.normalized === want && surface === tok.normalized) return true;
  return false;
}

function typedTokenForm(tok: QueryToken) {
  return String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
}

/**
 * Preceding configured-expansion tokens compare against typed surface first,
 * then retrieval identity. Morphology (`frames` → `frame`) must not block
 * alignment with a configured word such as `frames`.
 */
function tokenAlignsConfiguredExact(tok: QueryToken, want: string) {
  if (tokenExactConfiguredWord(tok, want)) return true;
  if (tok.normalized === want || tok.lemma === want) return true;
  return false;
}

function tokenAlignsConfiguredPrefix(tok: QueryToken, want: string) {
  const forms = [typedTokenForm(tok), tok.normalized, tok.lemma].filter(Boolean);
  return forms.some((form) =>
    tokenSatisfiesConfiguredToken(form, want, { isLast: true, allowShortLastPrefix: true })
  );
}

/**
 * Distinct keys for a span. Two or more keys sharing the same exact
 * expansion do not collapse. Insertion order, lexicographic order, and
 * `primary` are not used.
 */
function uniqueConfiguredKey(concepts: ConfiguredConcept[]) {
  const keys = new Set<string>();
  for (const e of concepts || []) {
    if (e?.key) keys.add(e.key);
  }
  if (keys.size !== 1) return null;
  return keys.values().next().value as string;
}

interface ConfiguredConceptMatchHit {
  concept: ConfiguredConcept;
  kind: string;
  from: number;
  to: number;
  matchedExpansionTokens: number;
  expansionTokenCount: number;
  expansionCoverage: number | undefined;
}

function exactConfiguredExpansionConceptsAt(tokens: QueryToken[], configured: SearchPlugin, from: number, n: number) {
  const concepts: ConfiguredConcept[] = [];
  const seen = new Set<string>();
  if (!configured?.sequences) return concepts;
  for (const seq of configured.sequences) {
    if (seq.kind !== "expansion") continue;
    if (seq.tokens.length !== n) continue;
    const key = seq.concept?.key;
    if (!key || seen.has(key)) continue;
    let exact = true;
    for (let j = 0; j < n; j++) {
      if (!tokenExactConfiguredWord(tokens[from + j], seq.tokens[j])) {
        exact = false;
        break;
      }
    }
    if (!exact) continue;
    seen.add(key);
    concepts.push(seq.concept);
  }
  return concepts;
}

function configuredExpansionPrefixConceptsAt(tokens: QueryToken[], configured: SearchPlugin, from: number, n: number) {
  const concepts: ConfiguredConcept[] = [];
  const seen = new Set<string>();
  if (!configured?.sequences) return concepts;
  for (const seq of configured.sequences) {
    if (seq.kind !== "expansion") continue;
    if (seq.tokens.length !== n) continue;
    const key = seq.concept?.key;
    if (!key || seen.has(key)) continue;
    let ok = true;
    for (let j = 0; j < n; j++) {
      const tok = tokens[from + j];
      const want = seq.tokens[j];
      if (tokenAlignsConfiguredExact(tok, want)) continue;
      const isLast = j === n - 1;
      if (isLast && tokenAlignsConfiguredPrefix(tok, want)) {
        continue;
      }
      ok = false;
      break;
    }
    if (!ok) continue;
    seen.add(key);
    concepts.push(seq.concept);
  }
  return concepts;
}

function provenanceForSequenceKinds(kinds: string[], usedPrefix: boolean) {
  if (usedPrefix) return "partial-expansion";
  if (kinds.length === 1 && kinds[0] === "key") return "key";
  if (kinds.includes("expansion") && !kinds.includes("alias")) return "expansion";
  if (kinds.includes("alias") && !kinds.includes("expansion") && !kinds.includes("key")) return "alias";
  if (kinds.includes("expansion")) return "expansion";
  if (kinds.includes("alias")) return "alias";
  return "key";
}

/**
 * Lemmatize configured expansion words with the same morphology rules as
 * typed query tokens, so "machine learning" and a projected "ml" share
 * canonical intent terms such as ["machine","learn"].
 */
function lemmatizedExpansionTokens(expansion: string[], plugins: SearchPlugin[]) {
  const out: QueryToken[] = [];
  for (const word of expansion || []) {
    const w = String(word || "");
    if (!w || isAllDigitToken(w)) continue;
    const lemma = pluginLemma(plugins, w);
    const canonical = pluginCanonicalLemma(plugins, w);
    const sources = ["configured-concept", "expansion"];
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

function attachConfiguredSequenceConcept(
  concepts: QueryConcept[],
  covered: Set<number>,
  tokenCount: number,
  resolution: ReturnType<typeof resolveConfiguredSequence>
): ConfiguredSequenceIntent | null {
  if (resolution.status === "ambiguous") {
    const drop = new Set(resolution.keys);
    for (let i = concepts.length - 1; i >= 0; i--) {
      if (concepts[i].kind === "configured-concept" && drop.has(concepts[i].id)) concepts.splice(i, 1);
    }
    covered.clear();
    return null;
  }
  if (resolution.status !== "unique") return null;
  const { intent, concept, usedPrefix } = resolution;
  for (let i = concepts.length - 1; i >= 0; i--) {
    if (concepts[i].kind === "configured-concept" && concepts[i].id !== intent.key) concepts.splice(i, 1);
  }
  const exists = concepts.some((c) => c.kind === "configured-concept" && c.id === intent.key);
  if (!exists) {
    const canonical = canonicalConfiguredConceptForm(concept);
    concepts.push({
      id: concept.key,
      kind: "configured-concept",
      forms: formsForConfiguredConcept(concept),
      expansion: [...canonical],
      aliases: additionalConfiguredConceptAliases(concept).map((a) => [...a]),
      provenance: provenanceForSequenceKinds(intent.matchedKinds, usedPrefix),
      matchedExpansionTokens: tokenCount,
      expansionTokenCount: canonical.length,
      expansionCoverage: Number((tokenCount / Math.max(canonical.length, 1)).toFixed(4)),
    });
  }
  for (let i = 0; i < tokenCount; i++) covered.add(i);
  return intent;
}

function configuredConceptOwnsExactTypedToken(concept: ConfiguredConcept | undefined, typed: string) {
  if (!concept || !typed) return false;
  if (concept.key === typed) return true;
  if (canonicalConfiguredConceptForm(concept).includes(typed)) return true;
  for (const alias of additionalConfiguredConceptAliases(concept)) {
    if (alias.includes(typed)) return true;
  }
  return false;
}

/**
 * Unique configured-expansion prefix completion of the trailing typed token.
 *
 * Typed tokens are not rewritten. The completed expansion prefix is a separate
 * canonical lexical-intent projection for phrase/ranking evidence.
 *
 * Trust/uniqueness: only configured expansion sequences (not aliases, not
 * corpus vocabulary). Preceding tokens must align exactly with E[0..k-2].
 * The last typed surface must be a non-empty proper prefix of E[k-1], and
 * must not already be an exact configured token of that same entry (key,
 * expansion word, or alias). If more than one distinct lemmatized
 * completed-prefix signature fits, do not project.
 */
function projectContextualExpansionIntent(
  tokens: QueryToken[],
  configured: SearchPlugin | null,
  plugins: SearchPlugin[]
): { tokens: QueryToken[]; meta: ContextualCompletion } | null {
  if (!configured?.sequences || tokens.length < 2) return null;
  const k = tokens.length;
  const last = tokens[k - 1];
  const typedLast = typedTokenForm(last);
  if (!typedLast || isAllDigitToken(typedLast) || DEFAULT_STOP.has(typedLast)) return null;

  const matches: Array<{ completedPrefix: string[]; completedWord: string }> = [];
  const signatures = new Set<string>();
  for (const seq of configured.sequences) {
    if (seq.kind !== "expansion") continue;
    const expansion = seq.tokens || [];
    if (expansion.length < k) continue;
    if (configuredConceptOwnsExactTypedToken(seq.concept, typedLast)) continue;
    let precedingOk = true;
    for (let j = 0; j < k - 1; j++) {
      if (!tokenAlignsConfiguredExact(tokens[j], expansion[j])) {
        precedingOk = false;
        break;
      }
    }
    if (!precedingOk) continue;
    const want = expansion[k - 1];
    if (!want || tokenExactConfiguredWord(last, want)) continue;
    if (!want.startsWith(typedLast) || typedLast.length >= want.length) continue;
    const completedPrefix = expansion.slice(0, k);
    const projected = lemmatizedExpansionTokens(completedPrefix, plugins);
    if (projected.length !== completedPrefix.length) continue;
    const signature = projected.map((t) => t.lemma || t.normalized).join("\0");
    if (!signatures.has(signature)) {
      signatures.add(signature);
      matches.push({ completedPrefix, completedWord: want });
    }
  }
  if (matches.length !== 1) return null;
  const chosen = matches[0];
  const projected = lemmatizedExpansionTokens(chosen.completedPrefix, plugins).map((t) => ({
    ...t,
    sources: t.sources.includes("contextual-completion")
      ? t.sources
      : [...t.sources, "contextual-completion"],
  }));
  const canonicalLast = projected[projected.length - 1];
  if (!canonicalLast) return null;
  return {
    tokens: projected,
    meta: {
      activePrefix: typedLast,
      completedToken: chosen.completedWord,
      canonicalToken: canonicalLast.lemma || canonicalLast.normalized,
      source: "configured-expansion-prefix",
    },
  };
}

function isSingleExpansionWordAliasSequence(seq: {
  kind?: string;
  tokens?: string[];
  concept?: ConfiguredConcept;
}) {
  if (seq.kind !== "alias") return false;
  const key = seq.concept?.key;
  const expansion = canonicalConfiguredConceptForm(seq.concept).filter((f) => f && f !== key && !/^\d+$/.test(f));
  const tokens = seq.tokens || [];
  return expansion.length >= 2 && tokens.length === 1 && expansion.includes(tokens[0]);
}

function matchConfiguredConceptSequences(tokens: QueryToken[], configured: SearchPlugin | null) {
  if (!configured || !configured.sequences) return [];
  const hits: ConfiguredConceptMatchHit[] = [];
  const used = new Set<number>();
  const norms = tokens.map((t) => t.normalized);
  for (const seq of configured.sequences) {
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
        const earlierExact =
          j === 0 ||
          tokens.slice(i, i + j).every((t, k) => tokenAlignsConfiguredExact(t, seq.tokens[k]));
        const allowShortLastPrefix =
          seq.kind !== "key" && n >= 2 && j === n - 1 && earlierExact;
        // Exact keys may match anywhere. Incomplete key prefixes are applied
        // later, and only to the unused final active token.
        if (seq.kind === "key") {
          if (tokenAlignsConfiguredKey(tokens[i + j], want, configured)) continue;
          ok = false;
          break;
        }
        if (tok === seq.concept.key && n === 1) {
          if (tok !== want && !tokenSatisfiesConfiguredToken(tok, want, { isLast: true })) {
            ok = false;
            break;
          }
          continue;
        }
        if (!tokenSatisfiesConfiguredToken(tok, want, { isLast: j === n - 1, allowShortLastPrefix })) {
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
          !tokenExactConfiguredWord(tokens[i + j], want)
        ) {
          lastWasPrefix = true;
        }
      }
      if (!ok) continue;
      if (seq.kind === "expansion") {
        const concepts = lastWasPrefix
          ? configuredExpansionPrefixConceptsAt(tokens, configured, i, n)
          : exactConfiguredExpansionConceptsAt(tokens, configured, i, n);
        const key = uniqueConfiguredKey(concepts);
        if (!key || key !== seq.concept.key) continue;
      }
      for (let j = 0; j < n; j++) used.add(i + j);
      const canonicalLen = canonicalConfiguredConceptForm(seq.concept).length;
      hits.push({
        concept: seq.concept,
        kind: lastWasPrefix ? "partial-expansion" : seq.kind,
        from: i,
        to: i + n,
        matchedExpansionTokens: n,
        expansionTokenCount: canonicalLen,
        expansionCoverage:
          seq.kind === "expansion" || lastWasPrefix
            ? Number((n / Math.max(canonicalLen, 1)).toFixed(4))
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
 */
function matchExpansionPrefixes(tokens: QueryToken[], configured: SearchPlugin | null, used: Set<number>) {
  if (!configured || !configured.sequences) return [];
  const norms = tokens.map((t) => t.normalized);
  const k = norms.length;
  if (k < MIN_EXPANSION_PREFIX_TOKENS) return [];
  const candidates: Array<ConfiguredConceptMatchHit & { expansionCoverage: number }> = [];
  const seen = new Set<string>();
  for (const seq of configured.sequences) {
    if (seq.kind !== "expansion") continue;
    const n = seq.tokens.length;
    if (n <= k) continue;
    const key = seq.concept?.key;
    if (!key || seen.has(key)) continue;
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (used.has(j)) {
        ok = false;
        break;
      }
      const want = seq.tokens[j];
      const isLast = j === k - 1;
      if (isLast) {
        if (!tokenAlignsConfiguredPrefix(tokens[j], want)) {
          ok = false;
          break;
        }
      } else if (!tokenAlignsConfiguredExact(tokens[j], want)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const coverage = k / n;
    if (coverage < MIN_EXPANSION_PREFIX_COVERAGE) continue;
    seen.add(key);
    candidates.push({
      concept: seq.concept,
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
      String(a.concept.key).localeCompare(String(b.concept.key))
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
 * Exact keys already matched anywhere in matchConfiguredConceptSequences.
 */
function matchFinalActiveKeyPrefix(tokens: QueryToken[], configured: SearchPlugin | null, used: Set<number>) {
  if (!configured || !configured.sequences) return [];
  const norms = tokens.map((t) => t.normalized);
  if (!norms.length) return [];
  const i = norms.length - 1;
  if (used.has(i)) return [];
  const tok = norms[i];
  const candidates: ConfiguredConcept[] = [];
  const seen = new Set<string>();
  for (const seq of configured.sequences) {
    if (seq.kind !== "key") continue;
    if (seq.tokens.length !== 1) continue;
    const key = seq.concept?.key;
    if (!key || seen.has(key)) continue;
    const want = seq.tokens[0];
    if (tok === want) continue;
    if (!tokenSatisfiesConfiguredToken(tok, want, { isLast: true })) continue;
    seen.add(key);
    candidates.push(seq.concept);
  }
  if (candidates.length !== 1) return [];
  const concept = candidates[0];
  used.add(i);
  const expansionLen = Math.max(canonicalConfiguredConceptForm(concept).length, 1);
  return [
    {
      concept,
      kind: "partial-expansion",
      from: i,
      to: i + 1,
      matchedExpansionTokens: 1,
      expansionTokenCount: expansionLen,
      expansionCoverage: Number((1 / expansionLen).toFixed(4)),
    },
  ];
}

function formsForConfiguredConcept(concept: ConfiguredConcept) {
  const forms = new Set([concept.key]);
  for (const seq of concept.aliases || []) {
    for (const w of seq) if (w) forms.add(w);
  }
  return [...forms];
}

function isPrefixOfVocabulary(token: unknown, lex: Iterable<string>) {
  const t = String(token || "");
  if (t.length < 4) return false;
  for (const w of lex) {
    if (typeof w === "string" && w.length > t.length && w.startsWith(t)) return true;
  }
  return false;
}

function isPlausibleCompletionToken(word: unknown) {
  return typeof word === "string" && /^[a-z]+$/.test(word);
}

/**
 * Apply the morphology plugin until it stabilizes (learning → learn).
 * Bounded so a malformed plugin that cycles cannot loop forever.
 */
function lemmaFixedPoint(lemmaFn: (t: string) => string, token: unknown) {
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
 */
function prefixCompletions(prefix: string, vocab: Set<string>) {
  const t = String(prefix || "");
  if (t.length < MIN_FINAL_PREFIX_LEN) return [];
  if (isAllDigitToken(t) || /\d/.test(t)) return [];
  if (DEFAULT_STOP.has(t)) return [];
  const out: string[] = [];
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
 */
function applyFinalTokenPrefixCompletion(
  tokens: QueryToken[],
  vocab: Set<string>,
  lemmaFn: (token: string) => string
): { tokens: QueryToken[]; prefixCompletion: PrefixCompletion | null } {
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
  const byCanon = new Map<string, string[]>();
  for (const word of completions) {
    const canon = lemmaFixedPoint(lemmaFn, word);
    if (!byCanon.has(canon)) byCanon.set(canon, []);
    byCanon.get(canon)?.push(word);
  }
  const canonicalTokens = [...byCanon.keys()].sort();
  if (!canonicalTokens.length) return { tokens, prefixCompletion: null };
  const unique = canonicalTokens.length === 1;
  let completedToken: string | null = null;
  let canonicalToken: string | null = null;
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

function configuredConceptKeysFrom(plugins: SearchPlugin[]) {
  const keys = new Set<string>();
  const configured = findConfiguredConceptPlugin(plugins);
  if (configured?.byKey) {
    for (const k of configured.byKey.keys()) keys.add(k);
  }
  return keys;
}

/**
 * Query analysis. Surface tokens are never discarded; alternatives carry
 * provenance. The final token may be replaced (not mutated) when a unique
 * prefix completion exists.
 */
export function analyzeQuery(
  rawQuery: unknown,
  { plugins = [], lexicon = [], prefixLexicon, signal }: AnalyzeOptions = {}
): AnalyzedQuery {
  throwIfAborted(signal);
  plugins = bindMorphologyDerivedEquivalences(plugins);
  const raw = String(rawQuery ?? "");
  const configured = findConfiguredConceptPlugin(plugins);
  const lex = lexiconFrom(plugins, lexicon);
  const prefixLex = prefixLexicon == null ? lex : lexiconFrom(plugins, prefixLexicon);
  const spellingLex = spellingLexiconFrom(plugins, lex);
  const configuredConceptKeys = configuredConceptKeysFrom(plugins);
  const explicitQueryIntentKeys = exactExplicitQueryIntentKeys(plugins);
  const alternatives: QueryAlternative[] = [];

  let surface = tokenize(raw);
  surface = repairUnknownExactCompounds(
    surface,
    lex,
    configuredConceptKeys,
    explicitQueryIntentKeys,
    plugins,
    alternatives
  );
  if (surface.length === 1) {
    const original = surface[0];
    if (!isProtectedFromUnknownRepair(original, lex, configuredConceptKeys, explicitQueryIntentKeys, plugins)) {
      const spelled = compoundSpellSegment(original, lex, { signal });
      if (spelled) {
        surface = spelled.tokens;
        alternatives.push({ tokens: spelled.tokens, source: spelled.source, confidence: 0.8 });
      } else {
        const salvaged = salvageContainedTerm(original, { lexicon: lex, configuredConceptKeys, signal });
        if (salvaged) {
          surface = salvaged.tokens;
          alternatives.push({ tokens: salvaged.tokens, source: salvaged.source, confidence: 0.7 });
        }
      }
    }
  }

  throwIfAborted(signal);

  const tokens: QueryToken[] = surface.map((surfaceTok) => {
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
    // Explicit lemma-table identity is more confident than edit-distance.
    // Suffix-heuristic stems stay on `lemma` and do not skip typo repair.
    const tableLemma = pluginCanonicalLemma(plugins, normalized);
    const exactExplicitIntent = explicitQueryIntentKeys.has(surfaceTok);
    const typoHits =
      exactExplicitIntent ||
      lex.has(normalized) ||
      configuredConceptKeys.has(normalized) ||
      isPrefixOfVocabulary(normalized, lex) ||
      tableLemma
        ? []
        : suggestTypoForms(normalized, spellingLex, { signal });
    const edit = typoHits.find((s) => s.provenance === "edit-distance" && spellingLex.has(s.form));
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

  const configuredHits = matchConfiguredConceptSequences(analyzedTokens, configured);
  const concepts: QueryConcept[] = [];
  const configuredOccupiedIndexes = new Set<number>();
  for (const hit of configuredHits) {
    for (let i = hit.from; i < hit.to; i++) configuredOccupiedIndexes.add(i);
  }
  const prefixHits = matchExpansionPrefixes(analyzedTokens, configured, configuredOccupiedIndexes);
  const keyPrefixHits = matchFinalActiveKeyPrefix(analyzedTokens, configured, configuredOccupiedIndexes);
  const covered = new Set<number>();
  for (const hit of [...configuredHits, ...prefixHits, ...keyPrefixHits]) {
    const forms = formsForConfiguredConcept(hit.concept);
    const canonical = canonicalConfiguredConceptForm(hit.concept);
    concepts.push({
      id: hit.concept.key,
      kind: "configured-concept",
      forms,
      expansion: [...canonical],
      aliases: additionalConfiguredConceptAliases(hit.concept).map((a) => [...a]),
      provenance: hit.kind,
      matchedExpansionTokens: hit.matchedExpansionTokens,
      expansionTokenCount: hit.expansionTokenCount,
      expansionCoverage: hit.expansionCoverage,
    });
    // Matched configured-concept spans occupy one canonical concept. Tokens outside
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

  const sequenceResolution = resolveConfiguredSequence(analyzedTokens, configured);
  const configuredSequenceIntent = attachConfiguredSequenceConcept(
    concepts,
    covered,
    analyzedTokens.length,
    sequenceResolution
  );
  const configuredSpans = resolveConfiguredSpans(analyzedTokens, configured);
  const configuredPrefixSpans = attachConfiguredPrefixSpanConcept(
    concepts,
    covered,
    analyzedTokens,
    configured,
    configuredSequenceIntent,
    configuredSpans
  );

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
        (v): v is string => typeof v === "string" && v.length > 0
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
    let spoken: string[] | null = null;
    for (const candidate of [tok.surface, tok.surfaceNormalized, tok.normalized]) {
      spoken = spokenSignificantSymbolTokens(candidate);
      if (spoken) break;
    }
    if (spoken) {
      forms.add(spoken.join(" "));
      if (!tok.sources.includes("significant-symbol")) tok.sources.push("significant-symbol");
      alternatives.push({
        tokens: spoken,
        source: "significant-symbol",
        confidence: 1,
      });
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

  const contextual = projectContextualExpansionIntent(analyzedTokens, configured, plugins);
  const lexicalTokens = configuredSequenceIntent
    ? contextual?.tokens?.length
      ? contextual.tokens
      : lemmatizedExpansionTokens(configuredSequenceIntent.expansion, plugins)
    : contextual?.tokens?.length
      ? contextual.tokens
      : analyzedTokens;
  const lexicalPhraseTokens = canonicalLexicalTokensFromQuery(lexicalTokens);
  const standaloneRecall = resolveStandaloneRecall(
    analyzedTokens,
    prefixCompletion,
    configuredSequenceIntent,
    concepts,
    configured
  );
  let topicalRecall = topicalRecallForKey(configuredSequenceIntent?.key, configured);
  if (!topicalRecall && !configuredSequenceIntent?.key) {
    topicalRecall = topicalRecallForKey(uniqueStopRemainderSpanKey(analyzedTokens, configuredSpans), configured);
  }

  const analyzed: AnalyzedQuery = {
    raw,
    originalSurface: tokenize(raw),
    tokens: analyzedTokens,
    concepts,
    alternatives,
    dottedSpans: dotted,
    prefixCompletion,
    contextualCompletion: contextual?.meta ?? null,
    configuredSequenceIntent,
    configuredSpans,
    configuredPrefixSpans,
    standaloneRecall,
    topicalRecall,
    lexicalTokens,
    lexicalPhraseTokens,
    lexicalPhraseKey: lexicalPhraseTokens.join(" "),
    stopstripped:
      analyzedTokens.length > 2
        ? analyzedTokens.filter((t) => !DEFAULT_STOP.has(t.normalized))
        : analyzedTokens,
  };
  attachSearchEquivalenceRecall(analyzed, analyzedTokens, covered, plugins);
  return analyzed;
}

/**
 * Conservative typo suggestions against a candidate vocabulary
 * (titles ∪ configured-concept lexicon ∪ morphology lemma-table keys).
 * Short alphanumeric literals (s3, h2, k8) are not treated as spelling errors.
 * Equal-distance edit candidates keep the lexicographically smaller form so the
 * choice does not depend on Set/corpus insertion order or document ids.
 * Work is O(|candidates|) with a ±2 length band and edit distance ≤ 2; lemma
 * keys enlarge that finite set and do not scan documents at query time.
 */
export function suggestTypoForms(
  token: unknown,
  candidateSet?: Iterable<string> | Set<string> | null,
  { signal }: { signal?: AbortSignal } = {}
): TypoSuggestion[] {
  const t = String(token || "");
  if (t.length < 5 || isAllDigitToken(t)) return [];
  if (/\d/.test(t) && t.length < 6) return [];
  const collapsed = collapseTrailingRepeats(t);
  const out: TypoSuggestion[] = [];
  if (collapsed !== t) out.push({ form: collapsed, distance: 1, provenance: "repeat-collapse" });
  let best: TypoSuggestion | null = null;
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
