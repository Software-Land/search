import { canonicalConfiguredConceptForm } from "./configuredAuthoring.js";
import { allowPrefixMatch, DEFAULT_STOP } from "./text.js";
import type {
  ConfiguredConcept,
  ConfiguredPrefixSpan,
  ConfiguredSpan,
  DictionarySequence,
  QueryToken,
  SearchPlugin,
} from "./types.js";

export type { ConfiguredPrefixSpan, ConfiguredSpan };

/**
 * Unique complete-query alignment to trusted configured sequences
 * (key, canonical expansion, aliases). Same-key multi-sequence matches
 * are not ambiguity. Distinct keys fail closed, except a unique whole-query
 * exact key outranks another concept's one-token alias/expansion of that
 * same typed form. Typed tokens are never rewritten here; callers project
 * canonical expansion as lexical intent so all unambiguous spellings of one
 * concept share ranking semantics.
 */
export interface ConfiguredSequenceIntent {
  key: string;
  expansion: string[];
  matchedKinds: string[];
}

export type ConfiguredAlignmentKind = "full" | "left-prefix" | "suffix";

export type ConfiguredSequenceResolution =
  | {
      status: "unique";
      intent: ConfiguredSequenceIntent;
      concept: ConfiguredConcept;
      usedPrefix: boolean;
      alignment: ConfiguredAlignmentKind;
    }
  | { status: "ambiguous"; keys: string[] }
  | { status: "none" };

function tokenForms(tok: QueryToken): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    const form = String(value || "").toLowerCase();
    if (form && !out.includes(form)) out.push(form);
  };
  add(tok.surfaceNormalized || tok.surface);
  add(tok.normalized);
  add(tok.lemma);
  return out;
}

function alignsExact(tok: QueryToken, want: string): boolean {
  if (!want) return false;
  for (const form of tokenForms(tok)) {
    if (form === want) return true;
  }
  return false;
}

function alignsNonLast(tok: QueryToken, want: string): boolean {
  if (alignsExact(tok, want)) return true;
  for (const form of tokenForms(tok)) {
    if (form.length >= want.length) continue;
    if (allowPrefixMatch(form, want)) return true;
  }
  return false;
}

function exactTypedToken(tok: QueryToken, want: string): boolean {
  if (!want || !tok) return false;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  return typed === want;
}

function alignsLast(tok: QueryToken, want: string): boolean {
  if (alignsExact(tok, want)) return true;
  for (const form of tokenForms(tok)) {
    if (!form || form.length >= want.length) continue;
    if (want.startsWith(form)) return true;
  }
  return false;
}

/**
 * A 1-token alias that is just one word of a multi-token expansion is not a
 * trusted complete-query sequence for prefix/span matching (bare `security`
 * is not appsec). Explicit unique exact whole-query aliases still occupy
 * through `uniqueExactOneTokenAlias`.
 */
function isSingleExpansionWordAlias(seq: DictionarySequence): boolean {
  if (seq.kind !== "alias") return false;
  const key = seq.concept?.key;
  const expansion = canonicalConfiguredConceptForm(seq.concept).filter((f) => f && f !== key && !/^\d+$/.test(f));
  const tokens = seq.tokens || [];
  return expansion.length >= 2 && tokens.length === 1 && expansion.includes(tokens[0]);
}

function exactTypedConfiguredKeys(tok: QueryToken, dict: SearchPlugin | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!dict?.sequences?.length || !tok) return keys;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (!typed) return keys;
  for (const seq of dict.sequences) {
    if (!seq?.concept?.key || !seq.tokens?.length) continue;
    if (seq.tokens.includes(typed)) keys.add(seq.concept.key);
  }
  return keys;
}

/**
 * Exact configured-key occupancy. Typed identity first; a valid morphology
 * lemma (or canonical normalized form) may occupy the same key when it
 * equals that key exactly and the typed token is not already an exact
 * configured token of a different key (`https` must not also occupy `http`).
 * No prefix, typo, or synonym forms.
 */
export function tokenAlignsConfiguredKey(
  tok: QueryToken,
  want: string,
  dict?: SearchPlugin | null
): boolean {
  if (!want || !tok) return false;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (typed === want) return true;
  const lemma = String(tok.lemma || "").toLowerCase();
  if (tok.normalized !== want && lemma !== want) return false;
  for (const key of exactTypedConfiguredKeys(tok, dict)) {
    if (key !== want) return false;
  }
  return true;
}

function alignsKey(tok: QueryToken, want: string, dict?: SearchPlugin | null): boolean {
  return tokenAlignsConfiguredKey(tok, want, dict);
}

function tokenIsStop(tok: QueryToken): boolean {
  return DEFAULT_STOP.has(String(tok.normalized || "").toLowerCase());
}

function lastTypedContentIndex(tokens: QueryToken[]): number {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!tokenIsStop(tokens[i])) return i;
  }
  return -1;
}

/**
 * Leading wrapper stops (`what is an …`) must not be skipped for whole-query
 * occupancy. Interior typed stops may be skipped during expansion/alias alignment.
 */
function leadingTypedStopBlocks(tokens: QueryToken[], want0: string): boolean {
  if (!tokens.length || !tokenIsStop(tokens[0])) return false;
  return !alignsExact(tokens[0], want0) && !alignsNonLast(tokens[0], want0);
}

type SequentialAlign = {
  ok: boolean;
  usedPrefix: boolean;
  matchedWant: number;
  typedContentMatched: number;
  consumedAllTyped: boolean;
  consumedAllWant: boolean;
};

/**
 * Sequential content alignment. Typed stop tokens may be skipped after the
 * first token; expansion tokens are never skipped. Content order is exact.
 * Prefixes are allowed only under the same last/non-last rules as positional
 * `sequenceAligns`. No corpus scan.
 */
function alignSequential(
  tokens: QueryToken[],
  want: string[],
  startJ: number,
  { allowNonLastPrefix }: { allowNonLastPrefix: boolean }
): SequentialAlign {
  const fail: SequentialAlign = {
    ok: false,
    usedPrefix: false,
    matchedWant: 0,
    typedContentMatched: 0,
    consumedAllTyped: false,
    consumedAllWant: false,
  };
  if (!tokens.length || !want.length || startJ < 0 || startJ >= want.length) return fail;
  const lastContent = lastTypedContentIndex(tokens);
  if (lastContent < 0) return fail;
  let i = 0;
  let j = startJ;
  let usedPrefix = false;
  let typedContentMatched = 0;
  while (i < tokens.length && j < want.length) {
    const tok = tokens[i];
    const target = want[j];
    const isLastTypedContent = i === lastContent;
    if (alignsExact(tok, target)) {
      if (!tokenIsStop(tok)) typedContentMatched += 1;
      i += 1;
      j += 1;
      continue;
    }
    if (isLastTypedContent && alignsLast(tok, target)) {
      usedPrefix = true;
      typedContentMatched += 1;
      i += 1;
      j += 1;
      continue;
    }
    if (!isLastTypedContent && allowNonLastPrefix && alignsNonLast(tok, target)) {
      usedPrefix = true;
      if (!tokenIsStop(tok)) typedContentMatched += 1;
      i += 1;
      j += 1;
      continue;
    }
    if (i > 0 && tokenIsStop(tok)) {
      i += 1;
      continue;
    }
    return fail;
  }
  while (i < tokens.length && tokenIsStop(tokens[i])) i += 1;
  const consumedAllTyped = i === tokens.length;
  const consumedAllWant = j === want.length;
  const matchedWant = j - startJ;
  if (!consumedAllTyped || matchedWant < 1) return fail;
  return {
    ok: true,
    usedPrefix,
    matchedWant,
    typedContentMatched,
    consumedAllTyped,
    consumedAllWant,
  };
}

function positionalSequenceAligns(
  tokens: QueryToken[],
  want: string[]
): { ok: boolean; usedPrefix: boolean } {
  if (want.length !== tokens.length) return { ok: false, usedPrefix: false };
  let usedPrefix = false;
  for (let i = 0; i < want.length; i++) {
    const tok = tokens[i];
    const target = want[i];
    const isLast = i === want.length - 1;
    if (isLast) {
      if (alignsExact(tok, target)) continue;
      if (!alignsLast(tok, target)) return { ok: false, usedPrefix };
      usedPrefix = true;
      continue;
    }
    if (alignsExact(tok, target)) continue;
    if (!alignsNonLast(tok, target)) return { ok: false, usedPrefix };
    usedPrefix = true;
  }
  return { ok: true, usedPrefix };
}

function sequenceAligns(
  tokens: QueryToken[],
  seq: DictionarySequence,
  dict?: SearchPlugin | null
): { ok: boolean; usedPrefix: boolean } {
  const want = seq.tokens || [];
  if (!want.length || !tokens.length) return { ok: false, usedPrefix: false };
  if (seq.kind === "key") {
    if (tokens.length !== 1 || !alignsKey(tokens[0], want[0], dict)) return { ok: false, usedPrefix: false };
    return { ok: true, usedPrefix: false };
  }
  if (seq.kind !== "expansion" && seq.kind !== "alias") return { ok: false, usedPrefix: false };
  // One-token alias/expansion occupy on exact typed identity only.
  // Last-token startsWith is reserved for n≥2 sequences with preceding context.
  if (want.length === 1) {
    if (tokens.length !== 1 || !exactTypedToken(tokens[0], want[0])) {
      return { ok: false, usedPrefix: false };
    }
    return { ok: true, usedPrefix: false };
  }
  if (want.length === tokens.length) {
    const positional = positionalSequenceAligns(tokens, want);
    if (positional.ok) return positional;
  }
  if (leadingTypedStopBlocks(tokens, want[0])) return { ok: false, usedPrefix: false };
  const aligned = alignSequential(tokens, want, 0, { allowNonLastPrefix: true });
  if (!aligned.ok || !aligned.consumedAllWant) return { ok: false, usedPrefix: aligned.usedPrefix };
  return { ok: true, usedPrefix: aligned.usedPrefix };
}

const MIN_EXPANSION_PREFIX_TOKENS = 2;
const MIN_EXPANSION_PREFIX_COVERAGE = 2 / 3;

function uniqueResolution(
  concept: ConfiguredConcept,
  matchedKinds: string[],
  usedPrefix: boolean,
  alignment: ConfiguredAlignmentKind = "full"
): ConfiguredSequenceResolution {
  return {
    status: "unique",
    intent: {
      key: concept.key,
      expansion: [...canonicalConfiguredConceptForm(concept)],
      matchedKinds,
    },
    concept,
    usedPrefix,
    alignment,
  };
}

/**
 * Unique left-prefix of a longer configured expansion (n > query length).
 * Same bounds as analyze `matchExpansionPrefixes`: ≥2 tokens, coverage ≥ 2/3,
 * unique best coverage. Distinct keys at that coverage fail closed (`none`),
 * so already-attached acronym concepts are not dropped.
 */
function uniqueExpansionLeftPrefix(
  tokens: QueryToken[],
  dict: SearchPlugin
): ConfiguredSequenceResolution {
  const k = tokens.length;
  if (k < MIN_EXPANSION_PREFIX_TOKENS || !dict.sequences?.length) return { status: "none" };
  const candidates: Array<{ seq: DictionarySequence; coverage: number; n: number; usedPrefix: boolean }> =
    [];
  const seen = new Set<string>();
  for (const seq of dict.sequences) {
    if (seq.kind !== "expansion" || !seq.concept?.key || !seq.tokens?.length) continue;
    const n = seq.tokens.length;
    if (n <= k) continue;
    if (seen.has(seq.concept.key)) continue;
    let usedPrefix = k < n;
    let ok = true;
    for (let j = 0; j < k; j++) {
      const want = seq.tokens[j];
      const tok = tokens[j];
      const isLast = j === k - 1;
      if (isLast) {
        if (alignsExact(tok, want)) continue;
        if (!alignsLast(tok, want)) {
          ok = false;
          break;
        }
        usedPrefix = true;
        continue;
      }
      if (!alignsExact(tok, want)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const coverage = k / n;
    if (coverage < MIN_EXPANSION_PREFIX_COVERAGE) continue;
    seen.add(seq.concept.key);
    candidates.push({ seq, coverage, n, usedPrefix });
  }
  if (!candidates.length) return { status: "none" };
  candidates.sort((a, b) => b.coverage - a.coverage || a.n - b.n);
  const best = candidates[0].coverage;
  const top = candidates.filter((c) => c.coverage === best);
  const keys = new Set(top.map((c) => c.seq.concept.key));
  if (keys.size !== 1) return { status: "none" };
  const hit = top[0];
  const entry = dict.byKey?.get(hit.seq.concept.key) || hit.seq.concept;
  return uniqueResolution(entry, ["expansion"], hit.usedPrefix, "left-prefix");
}

const MIN_EXPANSION_SUFFIX_CONTENT = 3;

type ExpansionAlignCandidate = {
  seq: DictionarySequence;
  coverage: number;
  n: number;
  usedPrefix: boolean;
};

function uniqueCandidateResolution(
  candidates: ExpansionAlignCandidate[],
  dict: SearchPlugin,
  alignment: ConfiguredAlignmentKind
): ConfiguredSequenceResolution {
  if (!candidates.length) return { status: "none" };
  candidates.sort((a, b) => b.coverage - a.coverage || a.n - b.n);
  const best = candidates[0].coverage;
  const top = candidates.filter((c) => c.coverage === best);
  const keys = new Set(top.map((c) => c.seq.concept.key));
  if (keys.size !== 1) return { status: "none" };
  const hit = top[0];
  const entry = dict.byKey?.get(hit.seq.concept.key) || hit.seq.concept;
  return uniqueResolution(entry, ["expansion"], hit.usedPrefix, alignment);
}

/**
 * Left-prefix when typed stops inflate query length so n <= k and the
 * positional `n > k` path cannot run. Interior typed stops may be skipped.
 * Non-last content tokens must be exact; the last typed content token may use
 * existing last-token prefix rules. Unique best coverage else none.
 */
function uniqueStopTolerantLeftPrefix(
  tokens: QueryToken[],
  dict: SearchPlugin
): ConfiguredSequenceResolution {
  if (tokens.length < MIN_EXPANSION_PREFIX_TOKENS || !dict.sequences?.length) return { status: "none" };
  if (tokenIsStop(tokens[0])) return { status: "none" };
  const candidates: ExpansionAlignCandidate[] = [];
  const seen = new Set<string>();
  for (const seq of dict.sequences) {
    if (seq.kind !== "expansion" || !seq.concept?.key || !seq.tokens?.length) continue;
    const n = seq.tokens.length;
    if (n < MIN_EXPANSION_PREFIX_TOKENS) continue;
    if (seen.has(seq.concept.key)) continue;
    if (leadingTypedStopBlocks(tokens, seq.tokens[0])) continue;
    const aligned = alignSequential(tokens, seq.tokens, 0, { allowNonLastPrefix: false });
    if (!aligned.ok || aligned.consumedAllWant) continue;
    if (aligned.typedContentMatched < MIN_EXPANSION_PREFIX_TOKENS) continue;
    const coverage = aligned.matchedWant / n;
    if (coverage < MIN_EXPANSION_PREFIX_COVERAGE) continue;
    seen.add(seq.concept.key);
    candidates.push({ seq, coverage, n, usedPrefix: aligned.usedPrefix });
  }
  return uniqueCandidateResolution(candidates, dict, "left-prefix");
}

/**
 * Unique suffix of a configured expansion. Typed content must align
 * contiguously (stop skips only) through the last expansion token, with at
 * least 3 typed content tokens. One-token and two-token interior fragments
 * fail closed. Distinct keys at the best coverage fail closed (`none`).
 */
function uniqueExpansionSuffix(
  tokens: QueryToken[],
  dict: SearchPlugin
): ConfiguredSequenceResolution {
  if (tokenIsStop(tokens[0]) || !dict.sequences?.length) return { status: "none" };
  const candidates: ExpansionAlignCandidate[] = [];
  const seen = new Set<string>();
  for (const seq of dict.sequences) {
    if (seq.kind !== "expansion" || !seq.concept?.key || !seq.tokens?.length) continue;
    const want = seq.tokens;
    const n = want.length;
    if (n < MIN_EXPANSION_SUFFIX_CONTENT + 1) continue;
    if (seen.has(seq.concept.key)) continue;
    let best: SequentialAlign | null = null;
    for (let startJ = 1; startJ < n; startJ++) {
      if (!alignsExact(tokens[0], want[startJ])) continue;
      const aligned = alignSequential(tokens, want, startJ, { allowNonLastPrefix: false });
      if (!aligned.ok || !aligned.consumedAllWant) continue;
      if (aligned.typedContentMatched < MIN_EXPANSION_SUFFIX_CONTENT) continue;
      const coverage = aligned.matchedWant / n;
      if (coverage < MIN_EXPANSION_PREFIX_COVERAGE) continue;
      if (!best || aligned.matchedWant > best.matchedWant) best = aligned;
    }
    if (!best) continue;
    seen.add(seq.concept.key);
    candidates.push({
      seq,
      coverage: best.matchedWant / n,
      n,
      usedPrefix: best.usedPrefix,
    });
  }
  return uniqueCandidateResolution(candidates, dict, "suffix");
}

/**
 * Explicit 1-token aliases occupy only as a unique exact whole-query form.
 * Prefix stubs, interior spans, and colliding aliases fail closed. Typed
 * surface is not rewritten. Dictionary `primary` is unused.
 */
function uniqueExactOneTokenAlias(
  tokens: QueryToken[],
  dict: SearchPlugin
): ConfiguredSequenceResolution {
  if (tokens.length !== 1 || tokenIsStop(tokens[0]) || !dict.sequences?.length) {
    return { status: "none" };
  }
  const matches: DictionarySequence[] = [];
  const keys = new Set<string>();
  for (const seq of dict.sequences) {
    if (!isSingleExpansionWordAlias(seq) || !seq.concept?.key) continue;
    if (!exactTypedToken(tokens[0], seq.tokens[0])) continue;
    matches.push(seq);
    keys.add(seq.concept.key);
  }
  if (!matches.length) return { status: "none" };
  if (keys.size > 1) return { status: "ambiguous", keys: [...keys] };
  const entry = dict.byKey?.get(matches[0].concept.key) || matches[0].concept;
  return uniqueResolution(entry, ["alias"], false, "full");
}

function configuredKeyPrefixKeys(tok: QueryToken, dict: SearchPlugin): string[] {
  const form = String(tok.normalized || "").toLowerCase();
  // Incomplete KEY guessing only. Exact configured keys occupy through
  // `tokenAlignsConfiguredKey` with no length gate. Length 1–2 prefixes of a
  // longer key are too ambiguous (many keys share `c`, `ap`, `io`).
  if (!form || form.length < 3 || !dict.sequences?.length) return [];
  const keys = new Set<string>();
  for (const seq of dict.sequences) {
    if (seq.kind !== "key" || seq.tokens?.length !== 1 || !seq.concept?.key) continue;
    const want = seq.tokens[0];
    if (!want || want === form) continue;
    if (want.startsWith(form)) keys.add(seq.concept.key);
  }
  return [...keys];
}

function tokenProperPrefixOf(tok: QueryToken, want: string): boolean {
  if (!want || !tok) return false;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (!typed || typed.length >= want.length) return false;
  return allowPrefixMatch(typed, want);
}

/**
 * One-token proper prefix of a configured expansion's first word.
 * Unique key prefixes occupy through the existing key-prefix path instead.
 * Several keys: occupy the unique longest expansion; same-length ties fail closed.
 * Insertion order and lexicographic key order are not used.
 */
function uniqueLongestFirstExpansionPrefix(
  tok: QueryToken,
  dict: SearchPlugin
): { concept: ConfiguredConcept } | null {
  if (!tok || !dict.sequences?.length) return null;
  if (configuredKeyPrefixKeys(tok, dict).length) return null;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (typed) {
    for (const seq of dict.sequences) {
      if (seq.kind !== "expansion" || !seq.tokens?.length) continue;
      if (seq.tokens[0] === typed) return null;
    }
  }
  const byKey = new Map<string, { concept: ConfiguredConcept; expansionLen: number }>();
  for (const seq of dict.sequences) {
    if (seq.kind !== "expansion" || !seq.concept?.key || !seq.tokens?.length) continue;
    const first = seq.tokens[0];
    if (!first || !tokenProperPrefixOf(tok, first)) continue;
    const expansionLen = Math.max(canonicalConfiguredConceptForm(seq.concept).length, seq.tokens.length);
    const prev = byKey.get(seq.concept.key);
    if (!prev || expansionLen > prev.expansionLen) {
      byKey.set(seq.concept.key, { concept: seq.concept, expansionLen });
    }
  }
  if (!byKey.size) return null;
  const rows = [...byKey.values()];
  if (rows.length === 1) return { concept: rows[0].concept };
  let bestLen = -1;
  const winners: ConfiguredConcept[] = [];
  for (const row of byKey.values()) {
    if (row.expansionLen > bestLen) {
      bestLen = row.expansionLen;
      winners.length = 0;
      winners.push(row.concept);
    } else if (row.expansionLen === bestLen) {
      winners.push(row.concept);
    }
  }
  if (winners.length !== 1) return null;
  return { concept: winners[0] };
}

/**
 * Whole-query unique exact key outranks another concept's one-token alias or
 * one-token expansion of the same typed form. Two distinct exact keys still
 * fail closed. n≥2 alias/expansion collisions are not overridden.
 */
function uniqueExactKeyOverForeignOneToken(
  chosen: Array<{ seq: DictionarySequence; usedPrefix: boolean }>
): string | null {
  const exactKeys = chosen.filter(
    (m) => m.seq.kind === "key" && !m.usedPrefix && (m.seq.tokens?.length || 0) === 1 && m.seq.concept?.key
  );
  const keySet = new Set(exactKeys.map((m) => m.seq.concept.key));
  if (keySet.size !== 1) return null;
  const winner = keySet.values().next().value as string;
  for (const m of chosen) {
    if (m.seq.concept.key === winner) continue;
    const n = m.seq.tokens?.length || 0;
    if (m.seq.kind === "key") return null;
    if ((m.seq.kind === "alias" || m.seq.kind === "expansion") && n === 1) continue;
    return null;
  }
  return winner;
}

/**
 * O(configured sequences × query tokens). Independent of corpus size.
 */
export function resolveConfiguredSequence(
  tokens: QueryToken[],
  dict: SearchPlugin | null | undefined
): ConfiguredSequenceResolution {
  if (!dict?.sequences?.length || !tokens.length) return { status: "none" };
  const matches: Array<{ seq: DictionarySequence; usedPrefix: boolean }> = [];
  for (const seq of dict.sequences) {
    if (!seq?.concept?.key || !seq.tokens?.length) continue;
    if (isSingleExpansionWordAlias(seq)) continue;
    const aligned = sequenceAligns(tokens, seq, dict);
    if (!aligned.ok) continue;
    matches.push({ seq, usedPrefix: aligned.usedPrefix });
  }
  if (matches.length) {
    const exact = matches.filter((m) => !m.usedPrefix);
    const chosen = exact.length ? exact : matches;
    const chosenKeys = new Set(chosen.map((m) => m.seq.concept.key));
    let resolved = chosen;
    if (chosenKeys.size > 1) {
      const winner = uniqueExactKeyOverForeignOneToken(chosen);
      if (!winner) return { status: "ambiguous", keys: [...chosenKeys] };
      resolved = chosen.filter((m) => m.seq.concept.key === winner);
    }
    const key = resolved[0].seq.concept.key;
    const entry = dict.byKey?.get(key) || resolved[0].seq.concept;
    const matchedKinds = [...new Set(resolved.map((m) => String(m.seq.kind || "")))].filter(Boolean);
    const usedPrefix = resolved.some((m) => m.usedPrefix);
    return uniqueResolution(entry, matchedKinds, usedPrefix, "full");
  }
  const exactOneTokenAlias = uniqueExactOneTokenAlias(tokens, dict);
  if (exactOneTokenAlias.status !== "none") return exactOneTokenAlias;
  const leftPrefix = uniqueExpansionLeftPrefix(tokens, dict);
  if (leftPrefix.status !== "none") return leftPrefix;
  const stopTolerantLeft = uniqueStopTolerantLeftPrefix(tokens, dict);
  if (stopTolerantLeft.status !== "none") return stopTolerantLeft;
  const suffix = uniqueExpansionSuffix(tokens, dict);
  if (suffix.status !== "none") return suffix;
  if (tokens.length === 1) {
    const hit = uniqueLongestFirstExpansionPrefix(tokens[0], dict);
    if (hit) return uniqueResolution(hit.concept, ["expansion"], true, "left-prefix");
  }
  return { status: "none" };
}

const SPAN_SEQUENCE_KINDS = new Set(["key", "expansion", "alias"]);

/**
 * Typed identity only for expansion/alias windows. Prefix completion and
 * last-token stubs must not create those spans. Configured keys may also
 * occupy from an exact morphology lemma (`apis` → `api`) without rewriting
 * typed surface. Whole-query `sequenceAligns` still allows last-token prefixes
 * on n≥2 sequences; one-token alias/expansion forms are exact-only.
 */

function sequenceAlignsExactAt(
  tokens: QueryToken[],
  start: number,
  seq: DictionarySequence,
  dict?: SearchPlugin | null
): boolean {
  const want = seq.tokens || [];
  const n = want.length;
  if (!n || start < 0 || start + n > tokens.length) return false;
  if (seq.kind === "key") {
    return n === 1 && tokenAlignsConfiguredKey(tokens[start], want[0], dict);
  }
  if (seq.kind !== "expansion" && seq.kind !== "alias") return false;
  for (let j = 0; j < n; j++) {
    if (!exactTypedToken(tokens[start + j], want[j])) return false;
  }
  return true;
}

function spanKeyId(key: string, start: number, end: number) {
  return `${key}\t${start}\t${end}`;
}

/**
 * Exact configured key/expansion/alias windows. Independent of corpus size.
 * Same-key duplicate forms at the same indexes collapse. Distinct keys are
 * all returned; callers fail closed for topical activation.
 */
export function resolveConfiguredSpans(
  tokens: QueryToken[],
  dict: SearchPlugin | null | undefined
): ConfiguredSpan[] {
  if (!dict?.sequences?.length || !tokens.length) return [];
  const grouped = new Map<string, { key: string; start: number; end: number; kinds: Set<string> }>();
  for (const seq of dict.sequences) {
    if (!seq?.concept?.key || !seq.tokens?.length) continue;
    if (!SPAN_SEQUENCE_KINDS.has(String(seq.kind || ""))) continue;
    if (isSingleExpansionWordAlias(seq)) continue;
    const n = seq.tokens.length;
    for (let start = 0; start <= tokens.length - n; start++) {
      if (!sequenceAlignsExactAt(tokens, start, seq, dict)) continue;
      const end = start + n;
      const id = spanKeyId(seq.concept.key, start, end);
      let row = grouped.get(id);
      if (!row) {
        row = { key: seq.concept.key, start, end, kinds: new Set() };
        grouped.set(id, row);
      }
      if (seq.kind) row.kinds.add(String(seq.kind));
    }
  }
  return [...grouped.values()]
    .map((row) => ({
      key: row.key,
      start: row.start,
      end: row.end,
      matchedKinds: [...row.kinds].sort(),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const PREFIX_SPAN_SEQUENCE_KINDS = new Set(["expansion", "alias"]);

function windowId(start: number, end: number) {
  return `${start}\t${end}`;
}

/**
 * Incomplete configured key/expansion/alias windows using the same
 * `sequenceAligns` prefix rules as whole-query resolution. n>=2 expansion/alias
 * windows plus unique 1-token first-expansion prefixes (longest expansion
 * wins; same-length ties fail closed). Exact windows stay on
 * `resolveConfiguredSpans`. Same-key forms at the same indexes collapse.
 * Distinct keys at the same indexes are dropped.
 */
export function resolveConfiguredPrefixSpans(
  tokens: QueryToken[],
  dict: SearchPlugin | null | undefined
): ConfiguredPrefixSpan[] {
  if (!dict?.sequences?.length || !tokens.length) return [];
  const exactWindows = new Set(
    resolveConfiguredSpans(tokens, dict).map((span) => windowId(span.start, span.end))
  );
  const grouped = new Map<
    string,
    { start: number; end: number; kinds: Set<string>; keys: Set<string> }
  >();
  for (const seq of dict.sequences) {
    if (!seq?.concept?.key || !seq.tokens?.length) continue;
    if (!PREFIX_SPAN_SEQUENCE_KINDS.has(String(seq.kind || ""))) continue;
    if (isSingleExpansionWordAlias(seq)) continue;
    const n = seq.tokens.length;
    if (n < 2) continue;
    for (let start = 0; start <= tokens.length - n; start++) {
      const aligned = sequenceAligns(tokens.slice(start, start + n), seq, dict);
      if (!aligned.ok || !aligned.usedPrefix) continue;
      const end = start + n;
      if (exactWindows.has(windowId(start, end))) continue;
      const id = windowId(start, end);
      let row = grouped.get(id);
      if (!row) {
        row = { start, end, kinds: new Set(), keys: new Set() };
        grouped.set(id, row);
      }
      row.keys.add(seq.concept.key);
      if (seq.kind) row.kinds.add(String(seq.kind));
    }
  }
  for (let start = 0; start < tokens.length; start++) {
    const tok = tokens[start];
    if (!tok || DEFAULT_STOP.has(String(tok.normalized || ""))) continue;
    if (exactWindows.has(windowId(start, start + 1))) continue;
    const end = start + 1;
    let contained = false;
    for (const row of grouped.values()) {
      if (start < row.end && end > row.start) {
        contained = true;
        break;
      }
    }
    if (contained) continue;
    const hit = uniqueLongestFirstExpansionPrefix(tok, dict);
    if (!hit?.concept?.key) continue;
    const id = windowId(start, end);
    let row = grouped.get(id);
    if (!row) {
      row = { start, end, kinds: new Set(), keys: new Set() };
      grouped.set(id, row);
    }
    row.keys.add(hit.concept.key);
    row.kinds.add("expansion");
  }
  return [...grouped.values()]
    .filter((row) => row.keys.size === 1)
    .map((row) => ({
      key: [...row.keys][0],
      start: row.start,
      end: row.end,
      matchedKinds: [...row.kinds].sort(),
      usedPrefix: true as const,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
