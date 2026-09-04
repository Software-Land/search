import { allConfiguredConceptForms, isOneTokenMemberOfLongerPeerForm, sequenceKey } from "./configuredAuthoring.js";
import { allowPrefixMatch, DEFAULT_STOP, STRUCTURAL_WRAPPER_STOP } from "./text.js";
import type {
  ConfiguredConcept,
  ConfiguredPrefixRecall,
  ConfiguredPrefixSpan,
  ConfiguredSpan,
  ConfiguredConceptSequence,
  QueryToken,
  SearchPlugin,
} from "./types.js";

export type { ConfiguredPrefixSpan, ConfiguredSpan };

/**
 * Unique complete-query alignment to trusted configured sequences
 * (key and peer alias forms). Same-key multi-sequence matches
 * are not ambiguity. Distinct keys fail closed, except a unique whole-query
 * exact key outranks another concept's one-token form of that
 * same typed form. Typed tokens are never rewritten here; callers project
 * concept-level peer-form evidence so all unambiguous spellings of one
 * concept share ranking semantics.
 */
export interface ConfiguredSequenceIntent {
  key: string;
  matchedForm: string[];
  matchedKinds: string[];
}

/**
 * Unique complete configured concept whose leftover tokens are only
 * structural wrappers (WH / copula / determiner). Exact configuredSpans
 * only; prefix spans never qualify. Coordinators and prepositions outside
 * the span are unmatched composition, not wrappers.
 */
export interface ConfiguredContentIdentity {
  key: string;
}

/**
 * One unique exact configured window occupying a suffix of the query, with
 * only STRUCTURAL_WRAPPER_STOP tokens before it. Does not set occupancy.
 * Does not consult search-equivalence concepts or prefix spans.
 */
export function resolveConfiguredContentIdentity(
  tokens: QueryToken[],
  exactSpans: ConfiguredSpan[] | null | undefined
): ConfiguredContentIdentity | null {
  if (!tokens.length || !exactSpans?.length) return null;
  const keys = new Set<string>();
  for (const span of exactSpans) {
    if (span?.key) keys.add(span.key);
  }
  if (keys.size !== 1) return null;
  const occupied = new Set<number>();
  for (const span of exactSpans) {
    if (!span?.key) continue;
    for (let i = span.start; i < span.end; i++) occupied.add(i);
  }
  if (!occupied.size) return null;
  let first = tokens.length;
  let last = -1;
  for (const i of occupied) {
    if (i < first) first = i;
    if (i > last) last = i;
  }
  if (last !== tokens.length - 1) return null;
  for (let i = first; i <= last; i++) {
    if (!occupied.has(i)) return null;
  }
  for (let i = 0; i < first; i++) {
    const tok = String(tokens[i]?.normalized || "").toLowerCase();
    if (!STRUCTURAL_WRAPPER_STOP.has(tok)) return null;
  }
  return { key: [...keys][0] };
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

function isConfiguredFormKind(kind: string | undefined) {
  return kind === "form";
}

/**
 * A 1-token form that is a member of any longer peer form is not a
 * trusted complete-query sequence for prefix/span matching (bare `security`
 * is not appsec). Explicit unique exact whole-query forms still occupy
 * through `uniqueExactOneTokenAlias`.
 */
function isSingleFormWordAlias(seq: ConfiguredConceptSequence): boolean {
  if (!isConfiguredFormKind(seq.kind)) return false;
  return isOneTokenMemberOfLongerPeerForm(seq.tokens, seq.concept);
}

function exactTypedConfiguredKeys(tok: QueryToken, configured: SearchPlugin | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!configured?.sequences?.length || !tok) return keys;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (!typed) return keys;
  for (const seq of configured.sequences) {
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
  configured?: SearchPlugin | null
): boolean {
  if (!want || !tok) return false;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (typed === want) return true;
  const lemma = String(tok.lemma || "").toLowerCase();
  if (tok.normalized !== want && lemma !== want) return false;
  for (const key of exactTypedConfiguredKeys(tok, configured)) {
    if (key !== want) return false;
  }
  return true;
}

function alignsKey(tok: QueryToken, want: string, configured?: SearchPlugin | null): boolean {
  return tokenAlignsConfiguredKey(tok, want, configured);
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
 * occupancy. Interior typed stops may be skipped during form/alias alignment.
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
  seq: ConfiguredConceptSequence,
  configured?: SearchPlugin | null
): { ok: boolean; usedPrefix: boolean } {
  const want = seq.tokens || [];
  if (!want.length || !tokens.length) return { ok: false, usedPrefix: false };
  if (seq.kind === "key") {
    if (tokens.length !== 1 || !alignsKey(tokens[0], want[0], configured)) return { ok: false, usedPrefix: false };
    return { ok: true, usedPrefix: false };
  }
  if (!isConfiguredFormKind(seq.kind)) return { ok: false, usedPrefix: false };
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

const MIN_FORM_PREFIX_TOKENS = 2;
const MIN_FORM_PREFIX_COVERAGE = 2 / 3;
/** Exact left prefixes occupy only when at least half the form is present. */
const MIN_EXACT_LEFT_PREFIX_COVERAGE = 1 / 2;

function uniqueResolution(
  concept: ConfiguredConcept,
  matchedKinds: string[],
  usedPrefix: boolean,
  alignment: ConfiguredAlignmentKind = "full",
  matchedForm: string[] = []
): ConfiguredSequenceResolution {
  return {
    status: "unique",
    intent: {
      key: concept.key,
      matchedForm: [...matchedForm],
      matchedKinds,
    },
    concept,
    usedPrefix,
    alignment,
  };
}

function compareFormCandidates(a: ExpansionAlignCandidate, b: ExpansionAlignCandidate) {
  return (
    b.coverage - a.coverage ||
    a.n - b.n ||
    sequenceKey(a.seq.tokens).localeCompare(sequenceKey(b.seq.tokens)) ||
    a.seq.concept.key.localeCompare(b.seq.concept.key)
  );
}

/**
 * Unique left-prefix of a longer configured form (n > query length).
 * Character-prefix last tokens keep the 2/3 coverage floor (same bound as
 * analyze `matchFormPrefixes`). Unique exact left prefixes occupy only at
 * coverage ≥ 1/2 (so `national institute` 2/4 occupies and `basically
 * available` 2/6 stays graded recall). A stop as the last newly aligned
 * query token does not occupy; weak prefix recall handles that case.
 * Distinct keys at the best coverage fail closed (`none`).
 */
function uniqueFormLeftPrefix(
  tokens: QueryToken[],
  configured: SearchPlugin
): ConfiguredSequenceResolution {
  const k = tokens.length;
  if (k < MIN_FORM_PREFIX_TOKENS || !configured.sequences?.length) return { status: "none" };
  const candidates: Array<{ seq: ConfiguredConceptSequence; coverage: number; n: number; usedPrefix: boolean }> =
    [];
  for (const seq of configured.sequences) {
    if (!isConfiguredFormKind(seq.kind) || !seq.concept?.key || !seq.tokens?.length) continue;
    const n = seq.tokens.length;
    if (n <= k) continue;
    let usedPrefix = k < n;
    let ok = true;
    let lastExact = false;
    for (let j = 0; j < k; j++) {
      const want = seq.tokens[j];
      const tok = tokens[j];
      const isLast = j === k - 1;
      if (isLast) {
        // Occupancy lastExact is typed surface. Prefix-completion rewrite of
        // `normalized` must not skip the 2/3 floor (`national inst`).
        if (exactTypedToken(tok, want)) {
          lastExact = true;
          continue;
        }
        if (!alignsLast(tok, want) && !alignsExact(tok, want)) {
          ok = false;
          break;
        }
        usedPrefix = true;
        lastExact = false;
        continue;
      }
      if (!alignsExact(tok, want)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const coverage = k / n;
    if (!lastExact) {
      if (coverage < MIN_FORM_PREFIX_COVERAGE) continue;
    } else if (tokenIsStop(tokens[k - 1])) {
      continue;
    } else if (coverage < MIN_EXACT_LEFT_PREFIX_COVERAGE) {
      continue;
    }
    candidates.push({ seq, coverage, n, usedPrefix });
  }
  return uniqueCandidateResolution(candidates, configured, "left-prefix");
}

const MIN_FORM_SUFFIX_CONTENT = 3;

type ExpansionAlignCandidate = {
  seq: ConfiguredConceptSequence;
  coverage: number;
  n: number;
  usedPrefix: boolean;
};

function uniqueCandidateResolution(
  candidates: ExpansionAlignCandidate[],
  configured: SearchPlugin,
  alignment: ConfiguredAlignmentKind
): ConfiguredSequenceResolution {
  if (!candidates.length) return { status: "none" };
  candidates.sort(compareFormCandidates);
  const best = candidates[0].coverage;
  const top = candidates.filter((c) => c.coverage === best);
  const keys = new Set(top.map((c) => c.seq.concept.key));
  if (keys.size !== 1) return { status: "none" };
  const hit = top[0];
  const concept = configured.byKey?.get(hit.seq.concept.key) || hit.seq.concept;
  return uniqueResolution(concept, ["form"], hit.usedPrefix, alignment, [...(hit.seq.tokens || [])]);
}

/**
 * Left-prefix when typed stops inflate query length so n <= k and the
 * positional `n > k` path cannot run. Interior typed stops may be skipped.
 * Non-last content tokens must be exact; the last typed content token may use
 * existing last-token prefix rules. Unique best coverage else none.
 */
function uniqueStopTolerantLeftPrefix(
  tokens: QueryToken[],
  configured: SearchPlugin
): ConfiguredSequenceResolution {
  if (tokens.length < MIN_FORM_PREFIX_TOKENS || !configured.sequences?.length) return { status: "none" };
  if (tokenIsStop(tokens[0])) return { status: "none" };
  const candidates: ExpansionAlignCandidate[] = [];
  for (const seq of configured.sequences) {
    if (!isConfiguredFormKind(seq.kind) || !seq.concept?.key || !seq.tokens?.length) continue;
    const n = seq.tokens.length;
    if (n < MIN_FORM_PREFIX_TOKENS) continue;
    if (leadingTypedStopBlocks(tokens, seq.tokens[0])) continue;
    const aligned = alignSequential(tokens, seq.tokens, 0, { allowNonLastPrefix: false });
    if (!aligned.ok || aligned.consumedAllWant) continue;
    if (aligned.typedContentMatched < MIN_FORM_PREFIX_TOKENS) continue;
    const coverage = aligned.matchedWant / n;
    if (coverage < MIN_FORM_PREFIX_COVERAGE) continue;
    candidates.push({ seq, coverage, n, usedPrefix: aligned.usedPrefix });
  }
  return uniqueCandidateResolution(candidates, configured, "left-prefix");
}

/**
 * Unique suffix of a configured peer form. Typed content must align
 * contiguously (stop skips only) through the last form token, with at
 * least 3 typed content tokens. One-token and two-token interior fragments
 * fail closed. Distinct keys at the best coverage fail closed (`none`).
 */
function uniqueFormSuffix(
  tokens: QueryToken[],
  configured: SearchPlugin
): ConfiguredSequenceResolution {
  if (tokenIsStop(tokens[0]) || !configured.sequences?.length) return { status: "none" };
  const candidates: ExpansionAlignCandidate[] = [];
  for (const seq of configured.sequences) {
    if (!isConfiguredFormKind(seq.kind) || !seq.concept?.key || !seq.tokens?.length) continue;
    const want = seq.tokens;
    const n = want.length;
    if (n < MIN_FORM_SUFFIX_CONTENT + 1) continue;
    let best: SequentialAlign | null = null;
    for (let startJ = 1; startJ < n; startJ++) {
      if (!alignsExact(tokens[0], want[startJ])) continue;
      const aligned = alignSequential(tokens, want, startJ, { allowNonLastPrefix: false });
      if (!aligned.ok || !aligned.consumedAllWant) continue;
      if (aligned.typedContentMatched < MIN_FORM_SUFFIX_CONTENT) continue;
      const coverage = aligned.matchedWant / n;
      if (coverage < MIN_FORM_PREFIX_COVERAGE) continue;
      if (!best || aligned.matchedWant > best.matchedWant) best = aligned;
    }
    if (!best) continue;
    candidates.push({
      seq,
      coverage: best.matchedWant / n,
      n,
      usedPrefix: best.usedPrefix,
    });
  }
  return uniqueCandidateResolution(candidates, configured, "suffix");
}

/**
 * Explicit 1-token aliases occupy only as a unique exact whole-query form.
 * Prefix stubs, interior spans, and colliding aliases fail closed. Typed
 * surface is not rewritten. Legacy authored `primary` is unused.
 */
function uniqueExactOneTokenAlias(
  tokens: QueryToken[],
  configured: SearchPlugin
): ConfiguredSequenceResolution {
  if (tokens.length !== 1 || tokenIsStop(tokens[0]) || !configured.sequences?.length) {
    return { status: "none" };
  }
  const matches: ConfiguredConceptSequence[] = [];
  const keys = new Set<string>();
  for (const seq of configured.sequences) {
    if (!isSingleFormWordAlias(seq) || !seq.concept?.key) continue;
    if (!exactTypedToken(tokens[0], seq.tokens[0])) continue;
    matches.push(seq);
    keys.add(seq.concept.key);
  }
  if (!matches.length) return { status: "none" };
  if (keys.size > 1) return { status: "ambiguous", keys: [...keys].sort() };
  const concept = configured.byKey?.get(matches[0].concept.key) || matches[0].concept;
  return uniqueResolution(concept, ["form"], false, "full", [...(matches[0].tokens || [])]);
}

type PrefixRecallCandidate = {
  seq: ConfiguredConceptSequence;
  exactCount: number;
  lastExact: boolean;
  partialCompleteness: number;
  evidence: number;
};

function typedPrefixOfWant(tok: QueryToken, want: string): string | null {
  for (const form of tokenForms(tok)) {
    if (form && form.length < want.length && want.startsWith(form)) return form;
  }
  return null;
}

function partialTokenCompleteness(tok: QueryToken, want: string): number {
  const prefix = typedPrefixOfWant(tok, want);
  if (!prefix || !want) return 0;
  return prefix.length / want.length;
}

function prefixRecallEvidence(exactCount: number, partialCompleteness: number, n: number): number {
  if (!(n > 0)) return 0;
  return (exactCount + partialCompleteness) / n;
}

function toConfiguredPrefixRecall(
  hit: PrefixRecallCandidate,
  configured: SearchPlugin
): ConfiguredPrefixRecall {
  const concept = configured.byKey?.get(hit.seq.concept.key) || hit.seq.concept;
  const form = [...(hit.seq.tokens || [])];
  return {
    key: concept.key,
    form,
    exactCount: hit.exactCount,
    formLength: form.length,
    coverage: Number(hit.evidence.toFixed(4)),
    lastExact: hit.lastExact,
    partialCompleteness: Number(hit.partialCompleteness.toFixed(4)),
  };
}

function comparePrefixRecallCandidates(a: PrefixRecallCandidate, b: PrefixRecallCandidate) {
  return (
    b.evidence - a.evidence ||
    a.seq.tokens.length - b.seq.tokens.length ||
    sequenceKey(a.seq.tokens).localeCompare(sequenceKey(b.seq.tokens))
  );
}

function bestPrefixRecallPerConcept(candidates: PrefixRecallCandidate[]): PrefixRecallCandidate[] {
  const byKey = new Map<string, PrefixRecallCandidate[]>();
  for (const hit of candidates) {
    const key = hit.seq.concept.key;
    const rows = byKey.get(key);
    if (rows) rows.push(hit);
    else byKey.set(key, [hit]);
  }
  const out: PrefixRecallCandidate[] = [];
  for (const rows of byKey.values()) {
    rows.sort(comparePrefixRecallCandidates);
    out.push(rows[0]);
  }
  return out;
}

function uniquePrefixRecallResolution(
  candidates: PrefixRecallCandidate[],
  configured: SearchPlugin,
  oneToken: boolean
): ConfiguredPrefixRecall | null {
  if (!candidates.length) return null;
  if (oneToken) {
    const keys = new Set(candidates.map((hit) => hit.seq.concept.key));
    if (keys.size !== 1) return null;
    const best = bestPrefixRecallPerConcept(candidates);
    return best[0] ? toConfiguredPrefixRecall(best[0], configured) : null;
  }
  const perConcept = bestPrefixRecallPerConcept(candidates);
  const rounded = (hit: PrefixRecallCandidate) => Number(hit.evidence.toFixed(4));
  const bestEvidence = Math.max(...perConcept.map(rounded));
  const top = perConcept.filter((hit) => rounded(hit) === bestEvidence);
  const keys = new Set(top.map((hit) => hit.seq.concept.key));
  if (keys.size !== 1) return null;
  return toConfiguredPrefixRecall(top[0], configured);
}

function strictLeftPrefixRecall(
  tokens: QueryToken[],
  seq: ConfiguredConceptSequence,
  { allowProperFirstPrefix = true }: { allowProperFirstPrefix?: boolean } = {}
): PrefixRecallCandidate | null {
  const want = seq.tokens || [];
  const n = want.length;
  const k = tokens.length;
  if (n < 2 || k < 1 || k >= n || tokenIsStop(tokens[0])) return null;
  if (k === 1) {
    if (exactTypedToken(tokens[0], want[0])) {
      const evidence = prefixRecallEvidence(1, 0, n);
      return { seq, exactCount: 1, lastExact: true, partialCompleteness: 0, evidence };
    }
    if (!allowProperFirstPrefix || !tokenProperPrefixOf(tokens[0], want[0])) return null;
    const partialCompleteness = partialTokenCompleteness(tokens[0], want[0]);
    if (!partialCompleteness) return null;
    return {
      seq,
      exactCount: 0,
      lastExact: false,
      partialCompleteness,
      evidence: prefixRecallEvidence(0, partialCompleteness, n),
    };
  }
  let lastExact = true;
  for (let j = 0; j < k; j++) {
    const target = want[j];
    const tok = tokens[j];
    const isLast = j === k - 1;
    if (isLast) {
      if (exactTypedToken(tok, target)) {
        lastExact = true;
        continue;
      }
      if (!alignsLast(tok, target)) return null;
      lastExact = false;
      continue;
    }
    if (!alignsExact(tok, target)) return null;
  }
  const exactCount = lastExact ? k : k - 1;
  const partialCompleteness = lastExact ? 0 : partialTokenCompleteness(tokens[k - 1], want[k - 1]);
  return {
    seq,
    exactCount,
    lastExact,
    partialCompleteness,
    evidence: prefixRecallEvidence(exactCount, partialCompleteness, n),
  };
}

function stopTolerantLeftPrefixRecall(
  tokens: QueryToken[],
  seq: ConfiguredConceptSequence
): PrefixRecallCandidate | null {
  const want = seq.tokens || [];
  const n = want.length;
  if (n < 2 || tokenIsStop(tokens[0])) return null;
  if (leadingTypedStopBlocks(tokens, want[0])) return null;
  const aligned = alignSequential(tokens, want, 0, { allowNonLastPrefix: false });
  if (!aligned.ok || aligned.consumedAllWant || aligned.matchedWant < 1) return null;
  if (aligned.typedContentMatched < 1) return null;
  const lastContent = lastTypedContentIndex(tokens);
  if (lastContent < 0) return null;
  const lastWant = want[aligned.matchedWant - 1];
  const lastTok = tokens[lastContent];
  const lastQuery = tokens[tokens.length - 1];
  const lastAlignedStop = tokenIsStop(lastQuery) && alignsExact(lastQuery, lastWant);
  if (tokenIsStop(lastQuery) && !lastAlignedStop && aligned.typedContentMatched < 2) {
    return null;
  }
  const lastExact = !aligned.usedPrefix;
  const exactCount = lastExact ? aligned.matchedWant : Math.max(aligned.matchedWant - 1, 0);
  if (exactCount < 1) return null;
  const partialCompleteness = lastExact ? 0 : partialTokenCompleteness(lastTok, lastWant);
  if (!lastExact && !partialCompleteness) return null;
  return {
    seq,
    exactCount,
    lastExact,
    partialCompleteness,
    evidence: prefixRecallEvidence(exactCount, partialCompleteness, n),
  };
}

/**
 * Unoccupied unique configured-form prefix/completion evidence.
 * Does not occupy, rewrite tokens, or attach a configured-concept.
 * One-token queries fail closed when the exact first token belongs to more
 * than one concept. A one-token proper prefix of a unique first form token is
 * graded recall, never occupancy; its evidence is weaker than the completed
 * exact first token. Same-concept forms keep the strongest evidence (a longer
 * authored form must not reduce a shorter matching form). Distinct concepts
 * at the best evidence fail closed; insertion order is unused. Configured
 * KEY prefixes stay on the existing key-prefix occupancy path.
 */
export function resolveConfiguredPrefixRecall(
  tokens: QueryToken[],
  configured: SearchPlugin | null | undefined
): ConfiguredPrefixRecall | null {
  if (!configured?.sequences?.length || !tokens.length) return null;
  const candidates: PrefixRecallCandidate[] = [];
  const oneToken = tokens.length === 1;
  const allowProperFirstPrefix = !(oneToken && configuredKeyPrefixKeys(tokens[0], configured).length);
  for (const seq of configured.sequences) {
    if (!isConfiguredFormKind(seq.kind) || isSingleFormWordAlias(seq) || !seq.concept?.key) continue;
    const strict = strictLeftPrefixRecall(tokens, seq, { allowProperFirstPrefix });
    if (strict) candidates.push(strict);
    else {
      const tolerant = stopTolerantLeftPrefixRecall(tokens, seq);
      if (tolerant) candidates.push(tolerant);
    }
  }
  return uniquePrefixRecallResolution(candidates, configured, oneToken);
}

function configuredKeyPrefixKeys(tok: QueryToken, configured: SearchPlugin): string[] {
  const form = String(tok.normalized || "").toLowerCase();
  // Incomplete KEY guessing only. Exact configured keys occupy through
  // `tokenAlignsConfiguredKey` with no length gate. Length 1–2 prefixes of a
  // longer key are too ambiguous (many keys share `c`, `ap`, `io`).
  if (!form || form.length < 3 || !configured.sequences?.length) return [];
  const keys = new Set<string>();
  for (const seq of configured.sequences) {
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
 * One-token proper prefix of a configured form's first word.
 * Unique key prefixes occupy through the existing key-prefix path instead.
 * Whole-query occupancy no longer uses this path; graded prefix recall does.
 * Prefix-span matching still uses longest unique form / same-length fail-closed
 * only for leftover 1-token windows, not as a stronger occupancy than the
 * completed first token.
 */
export function uniqueLongestFirstFormPrefix(
  tok: QueryToken,
  configured: SearchPlugin
): { concept: ConfiguredConcept; matchedForm: string[] } | null {
  if (!tok || !configured.sequences?.length) return null;
  if (configuredKeyPrefixKeys(tok, configured).length) return null;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (typed) {
    for (const seq of configured.sequences) {
      if (!isConfiguredFormKind(seq.kind) || (seq.tokens?.length || 0) < 2) continue;
      if (seq.tokens[0] === typed) return null;
    }
  }
  const byKey = new Map<string, { concept: ConfiguredConcept; formLen: number; matchedForm: string[] }>();
  for (const seq of configured.sequences) {
    if (!isConfiguredFormKind(seq.kind) || !seq.concept?.key || (seq.tokens?.length || 0) < 2) continue;
    if (isSingleFormWordAlias(seq)) continue;
    const first = seq.tokens[0];
    if (!first || !tokenProperPrefixOf(tok, first)) continue;
    const formLen = seq.tokens.length;
    const prev = byKey.get(seq.concept.key);
    const formKey = sequenceKey(seq.tokens);
    if (
      !prev ||
      formLen > prev.formLen ||
      (formLen === prev.formLen && formKey < sequenceKey(prev.matchedForm))
    ) {
      byKey.set(seq.concept.key, { concept: seq.concept, formLen, matchedForm: [...seq.tokens] });
    }
  }
  if (!byKey.size) return null;
  const rows = [...byKey.values()];
  if (rows.length === 1) return { concept: rows[0].concept, matchedForm: rows[0].matchedForm };
  let bestLen = -1;
  const winners: Array<{ concept: ConfiguredConcept; matchedForm: string[] }> = [];
  for (const row of byKey.values()) {
    if (row.formLen > bestLen) {
      bestLen = row.formLen;
      winners.length = 0;
      winners.push({ concept: row.concept, matchedForm: row.matchedForm });
    } else if (row.formLen === bestLen) {
      winners.push({ concept: row.concept, matchedForm: row.matchedForm });
    }
  }
  if (winners.length !== 1) return null;
  return winners[0];
}

/**
 * Whole-query unique exact key outranks another concept's one-token alias or
 * one-token expansion of the same typed form. Two distinct exact keys still
 * fail closed. n≥2 alias/expansion collisions are not overridden.
 */
function uniqueExactKeyOverForeignOneToken(
  chosen: Array<{ seq: ConfiguredConceptSequence; usedPrefix: boolean }>
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
    if (isConfiguredFormKind(m.seq.kind) && n === 1) continue;
    return null;
  }
  return winner;
}

/**
 * O(configured sequences × query tokens). Independent of corpus size.
 */
export function resolveConfiguredSequence(
  tokens: QueryToken[],
  configured: SearchPlugin | null | undefined
): ConfiguredSequenceResolution {
  if (!configured?.sequences?.length || !tokens.length) return { status: "none" };
  const matches: Array<{ seq: ConfiguredConceptSequence; usedPrefix: boolean }> = [];
  for (const seq of configured.sequences) {
    if (!seq?.concept?.key || !seq.tokens?.length) continue;
    if (isSingleFormWordAlias(seq)) continue;
    const aligned = sequenceAligns(tokens, seq, configured);
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
      if (!winner) return { status: "ambiguous", keys: [...chosenKeys].sort() };
      resolved = chosen.filter((m) => m.seq.concept.key === winner);
    }
    const key = resolved[0].seq.concept.key;
    const concept = configured.byKey?.get(key) || resolved[0].seq.concept;
    const matchedKinds = [...new Set(resolved.map((m) => String(m.seq.kind || "")))].filter(Boolean).sort();
    const usedPrefix = resolved.some((m) => m.usedPrefix);
    const formHits = resolved.filter((m) => isConfiguredFormKind(m.seq.kind));
    formHits.sort(
      (a, b) =>
        (b.seq.tokens?.length || 0) - (a.seq.tokens?.length || 0) ||
        sequenceKey(a.seq.tokens).localeCompare(sequenceKey(b.seq.tokens))
    );
    const matchedForm = formHits.length ? [...(formHits[0].seq.tokens || [])] : [];
    return uniqueResolution(concept, matchedKinds, usedPrefix, "full", matchedForm);
  }
  const exactOneTokenAlias = uniqueExactOneTokenAlias(tokens, configured);
  if (exactOneTokenAlias.status !== "none") return exactOneTokenAlias;
  const leftPrefix = uniqueFormLeftPrefix(tokens, configured);
  if (leftPrefix.status !== "none") return leftPrefix;
  const stopTolerantLeft = uniqueStopTolerantLeftPrefix(tokens, configured);
  if (stopTolerantLeft.status !== "none") return stopTolerantLeft;
  const suffix = uniqueFormSuffix(tokens, configured);
  if (suffix.status !== "none") return suffix;
  return { status: "none" };
}

const SPAN_SEQUENCE_KINDS = new Set(["key", "form"]);

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
  seq: ConfiguredConceptSequence,
  configured?: SearchPlugin | null
): boolean {
  const want = seq.tokens || [];
  const n = want.length;
  if (!n || start < 0 || start + n > tokens.length) return false;
  if (seq.kind === "key") {
    return n === 1 && tokenAlignsConfiguredKey(tokens[start], want[0], configured);
  }
  if (!isConfiguredFormKind(seq.kind)) return false;
  for (let j = 0; j < n; j++) {
    if (!exactTypedToken(tokens[start + j], want[j])) return false;
  }
  return true;
}

function spanKeyId(key: string, start: number, end: number) {
  return `${key}\t${start}\t${end}`;
}

/**
 * Exact configured key/form/alias windows. Independent of corpus size.
 * Same-key duplicate forms at the same indexes collapse. Distinct keys are
 * all returned; callers fail closed for topical activation.
 */
export function resolveConfiguredSpans(
  tokens: QueryToken[],
  configured: SearchPlugin | null | undefined
): ConfiguredSpan[] {
  if (!configured?.sequences?.length || !tokens.length) return [];
  const grouped = new Map<string, { key: string; start: number; end: number; kinds: Set<string> }>();
  for (const seq of configured.sequences) {
    if (!seq?.concept?.key || !seq.tokens?.length) continue;
    if (!SPAN_SEQUENCE_KINDS.has(String(seq.kind || ""))) continue;
    if (isSingleFormWordAlias(seq)) continue;
    const n = seq.tokens.length;
    for (let start = 0; start <= tokens.length - n; start++) {
      if (!sequenceAlignsExactAt(tokens, start, seq, configured)) continue;
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

const PREFIX_SPAN_SEQUENCE_KINDS = new Set(["form"]);

function windowId(start: number, end: number) {
  return `${start}\t${end}`;
}

/**
 * Incomplete configured form windows using the same `sequenceAligns` prefix
 * rules as whole-query resolution. n>=2 form windows only. One-token proper
 * first-form prefixes are graded `configuredPrefixRecall`, not occupancy spans.
 * Exact windows stay on `resolveConfiguredSpans`. Same-key forms at the same
 * indexes collapse. Distinct keys at the same indexes are dropped.
 */
export function resolveConfiguredPrefixSpans(
  tokens: QueryToken[],
  configured: SearchPlugin | null | undefined
): ConfiguredPrefixSpan[] {
  if (!configured?.sequences?.length || !tokens.length) return [];
  const exactWindows = new Set(
    resolveConfiguredSpans(tokens, configured).map((span) => windowId(span.start, span.end))
  );
  const grouped = new Map<
    string,
    { start: number; end: number; kinds: Set<string>; keys: Set<string> }
  >();
  for (const seq of configured.sequences) {
    if (!seq?.concept?.key || !seq.tokens?.length) continue;
    if (!PREFIX_SPAN_SEQUENCE_KINDS.has(String(seq.kind || ""))) continue;
    if (isSingleFormWordAlias(seq)) continue;
    const n = seq.tokens.length;
    if (n < 2) continue;
    for (let start = 0; start <= tokens.length - n; start++) {
      const aligned = sequenceAligns(tokens.slice(start, start + n), seq, configured);
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
