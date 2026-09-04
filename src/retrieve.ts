import { isOneTokenMemberOfLongerPeerForm, sequenceKey } from "./configuredAuthoring.js";
import { isNearCompletePrefix, allowPrefixMatch, DEFAULT_STOP, STRUCTURAL_WRAPPER_STOP } from "./text.js";
import { dropConfiguredPrefixRecallTrailingStop } from "./configuredSequence.js";
import { querySemanticFacts } from "./querySemantics.js";
import {
  isAllDigitToken,
  queryTokenMatchesVersionCompact,
  hasIndependentTitleForm,
} from "./versionForms.js";
import { throwIfAborted } from "./cancel.js";
import {
  asCompactStore,
  compactAdjacentTokens,
  compactBodyMatchesConcept,
  compactHasIndependentTitleForm,
  compactOrdinal,
  compactTitleHasLemma,
  compactTitleHasPrefixForm,
  KIND_BODY,
  KIND_BODY_LEMMA,
  KIND_TITLE,
  KIND_TITLE_LEMMA,
} from "./compactDocuments.js";
import type {
  AnalyzedQuery,
  ContextualTitlePrefix,
  IndexedDocument,
  QueryConcept,
  QueryToken,
  RetrievalHit,
  RetrieveOptions,
  SearchIndex,
  StandaloneRecall,
  TopicalRecall,
} from "./types.js";

type ConceptTitleMatch = "key" | "form" | "exact" | "prefix" | "lemma";
type VersionCompanion = "none" | "absent" | "covered" | "weak";

interface VersionHit {
  compactHit: boolean;
  dottedHit: boolean;
  companion: VersionCompanion;
  numberConcepts: number;
}

export function sequencePresent(needles: string[], hay: string[] | ArrayLike<string>) {
  const n = needles.length;
  if (!n || hay.length < n) return false;
  for (let i = 0; i <= hay.length - n; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (hay[i + j] !== needles[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Exact contiguous occurrence count. Same token identity as `sequencePresent`. */
export function sequenceCount(needles: string[], hay: string[] | ArrayLike<string>): number {
  const n = needles.length;
  if (!n || hay.length < n) return 0;
  let count = 0;
  for (let i = 0; i <= hay.length - n; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (hay[i + j] !== needles[j]) {
        ok = false;
        break;
      }
    }
    if (ok) count += 1;
  }
  return count;
}

export function formContentTokens(form: string[]): string[] {
  return (form || []).filter((f) => f && !/^\d+$/.test(f) && !DEFAULT_STOP.has(f));
}

export function configuredPeerForms(concept: QueryConcept | null | undefined): string[][] {
  const aliases = concept?.aliases;
  if (Array.isArray(aliases) && aliases.length) {
    const out: string[][] = [];
    const seen = new Set<string>();
    for (const alias of aliases) {
      const seq = (alias || []).filter((f) => f && !/^\d+$/.test(f));
      if (!seq.length) continue;
      const key = sequenceKey(seq);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(seq);
    }
    return out.sort((a, b) => sequenceKey(a).localeCompare(sequenceKey(b)));
  }
  if (Array.isArray(concept?.matchedForm) && concept.matchedForm.length) {
    const seq = concept.matchedForm.filter((f) => f && f !== concept.id && !/^\d+$/.test(f));
    return seq.length ? [seq] : [];
  }
  return [];
}

/**
 * Multi-token forms require the form as a contiguous phrase.
 * Title fields may also accept a complete token set (short titles).
 * Body fields require a contiguous normalized phrase — dispersed
 * body tokens are not full configured-concept evidence.
 * A single token that is a member of any longer peer form is never full
 * multi-token configured-concept evidence.
 */
function isSingleFormWordAlias(seq: string[], peerForms: string[][]) {
  return isOneTokenMemberOfLongerPeerForm(seq, { aliases: peerForms });
}

function fieldHasFormEvidence(
  form: string[],
  tokens: string[],
  lemmas: string[],
  tokenSet: Set<string>,
  lemmaSet: Set<string>,
  { requireContiguous = false }: { requireContiguous?: boolean } = {}
) {
  if (!form.length) return false;
  if (form.length === 1) {
    if (DEFAULT_STOP.has(form[0])) return false;
    return tokenSet.has(form[0]) || lemmaSet.has(form[0]);
  }
  if (sequencePresent(form, tokens) || sequencePresent(form, lemmas)) return true;
  if (requireContiguous) return false;
  const content = formContentTokens(form);
  if (!content.length) return false;
  return content.every((f) => tokenSet.has(f) || lemmaSet.has(f));
}

function acronymFieldEvidence(
  concept: QueryConcept,
  tokens: string[],
  lemmas: string[],
  tokenSet: Set<string>,
  lemmaSet: Set<string>,
  opts: { requireContiguous?: boolean } = {}
) {
  return configuredConceptFieldMatch(concept, tokens, lemmas, tokenSet, lemmaSet, opts) !== false;
}

export type ConfiguredFieldMatch = false | "key" | "form";

/**
 * Key vs complete peer form in one field. A single token that is a member of
 * a longer peer form is never `form`. Lemma matching uses the field lemma set.
 */
export function configuredConceptFieldMatch(
  concept: QueryConcept,
  tokens: string[],
  lemmas: string[],
  tokenSet: Set<string>,
  lemmaSet: Set<string>,
  opts: { requireContiguous?: boolean } = {}
): ConfiguredFieldMatch {
  if (concept.kind !== "configured-concept") return false;
  if (tokenSet.has(concept.id) || lemmaSet.has(concept.id)) return "key";
  const peerForms = configuredPeerForms(concept);
  for (const seq of peerForms) {
    if (isSingleFormWordAlias(seq, peerForms)) continue;
    if (fieldHasFormEvidence(seq, tokens, lemmas, tokenSet, lemmaSet, opts)) return "form";
  }
  return false;
}

/**
 * Forms that may generate title-token PREFIX evidence. A morphology-derived
 * lemma that is a proper prefix of another form in the same concept
 * (`frame` of typed `frames`) must not prefix a longer different title token
 * (`framework`). Independent exact/lemma token matches still use the full bag.
 */
function titlePrefixableForms(forms: string[] | undefined) {
  const list = forms || [];
  return list.filter((form) => {
    if (!form || /^\d+$/.test(form) || /\s/.test(form)) return false;
    return !list.some((other) => other !== form && other.startsWith(form) && other.length > form.length);
  });
}

function phraseFormTokens(form: string): string[] | null {
  const seq = String(form || "").split(/\s+/).filter(Boolean);
  return seq.length >= 2 ? seq : null;
}

function conceptPhraseMatchesTitle(concept: QueryConcept, doc: IndexedDocument): ConceptTitleMatch | null {
  const store = asCompactStore(doc);
  const ordinal = store ? compactOrdinal(doc) : 0;
  for (const form of concept.forms || []) {
    const seq = phraseFormTokens(form);
    if (!seq) continue;
    if (store) {
      if (compactAdjacentTokens(store, ordinal, KIND_TITLE, seq, (qt, tt) => qt === tt)) return "exact";
      if (compactAdjacentTokens(store, ordinal, KIND_TITLE_LEMMA, seq, (qt, tt) => qt === tt)) return "lemma";
      continue;
    }
    if (sequencePresent(seq, doc.titleTokens)) return "exact";
    if (sequencePresent(seq, doc.titleLemmas)) return "lemma";
  }
  return null;
}

function conceptPhraseMatchesBody(concept: QueryConcept, doc: IndexedDocument): boolean {
  const store = asCompactStore(doc);
  const ordinal = store ? compactOrdinal(doc) : 0;
  for (const form of concept.forms || []) {
    const seq = phraseFormTokens(form);
    if (!seq) continue;
    if (store) {
      if (compactAdjacentTokens(store, ordinal, KIND_BODY, seq, (qt, tt) => qt === tt)) return true;
      if (compactAdjacentTokens(store, ordinal, KIND_BODY_LEMMA, seq, (qt, tt) => qt === tt)) return true;
      continue;
    }
    if (sequencePresent(seq, doc.bodyTokens) || sequencePresent(seq, doc.bodyLemmas)) return true;
  }
  return false;
}

function conceptMatchesTitle(concept: QueryConcept, doc: IndexedDocument): ConceptTitleMatch | null {
  if (concept.kind === "configured-concept") {
    if (doc.titleTokenSet.has(concept.id) || doc.titleLemmaSet.has(concept.id)) return "key";
    if (
      acronymFieldEvidence(
        concept,
        doc.titleTokens,
        doc.titleLemmas,
        doc.titleTokenSet,
        doc.titleLemmaSet,
        { requireContiguous: false }
      )
    ) {
      return "form";
    }
    return null;
  }
  const phraseHit = conceptPhraseMatchesTitle(concept, doc);
  if (phraseHit) return phraseHit;
  const store = asCompactStore(doc);
  if (store) {
    const ordinal = compactOrdinal(doc);
    for (const form of concept.forms) {
      if (phraseFormTokens(form)) continue;
      if (compactHasIndependentTitleForm(store, ordinal, form)) return "exact";
      if (compactTitleHasLemma(store, ordinal, form)) return "lemma";
    }
    for (const form of titlePrefixableForms(concept.forms)) {
      if (compactTitleHasPrefixForm(store, ordinal, form, allowPrefixMatch)) return "prefix";
    }
    return null;
  }
  for (const form of concept.forms) {
    if (phraseFormTokens(form)) continue;
    if (hasIndependentTitleForm(doc, form)) return "exact";
    for (const tok of doc.titleLemmas) {
      if (form === tok) return "lemma";
    }
  }
  for (const form of titlePrefixableForms(concept.forms)) {
    for (const tok of doc.titleTokens) {
      if (allowPrefixMatch(form, tok)) return "prefix";
    }
  }
  return null;
}

function conceptMatchesBody(concept: QueryConcept, doc: IndexedDocument) {
  if (concept.kind === "configured-concept") {
    return acronymFieldEvidence(
      concept,
      doc.bodyTokens,
      doc.bodyLemmas,
      doc.bodyTokenSet,
      doc.bodyLemmaSet,
      { requireContiguous: true }
    );
  }
  if (conceptPhraseMatchesBody(concept, doc)) return true;
  const store = asCompactStore(doc);
  if (store) {
    return compactBodyMatchesConcept(
      store,
      compactOrdinal(doc),
      (concept.forms || []).filter((form) => !phraseFormTokens(form))
    );
  }
  for (const form of concept.forms) {
    if (phraseFormTokens(form)) continue;
    if (doc.bodyTokenSet.has(form) || doc.bodyLemmaSet.has(form)) return true;
    if (/^\d+$/.test(form)) continue;
    for (const tok of doc.bodyTokens) {
      if (/^\d+$/.test(tok)) continue;
      if (form.length >= 3 && tok.startsWith(form)) return true;
    }
  }
  return false;
}

/**
 * Typed/repaired ranking evidence: surfaceNormalized after allowed surface
 * repair, frozen before lemma and unique-prefix completion. Use this for
 * "what did the user type?" / "how complete was the typing?" features.
 * Never substitute normalized, lemma, completedToken, or
 * prefixCompletion.canonicalToken.
 */
export function typedForm(token: Pick<QueryToken, "surface" | "surfaceNormalized">): string {
  return token.surfaceNormalized ?? token.surface;
}

/**
 * Unique contextual form completion binds the trailing typed token to one
 * configured form word. The typed stub stays on the query for explain;
 * it must not independently generate unbound lexical evidence unless the user
 * already typed that completed word or its canonical lemma (`learn` of
 * `learning`). Short proper prefixes (`sec`, `prot`, `l`) are consumed.
 */
export function hasBoundContextualCompletion(query: AnalyzedQuery) {
  return querySemanticFacts(query).completion.boundTrailing;
}

export function shouldConsumeBoundTrailingToken(query: AnalyzedQuery) {
  if (!hasBoundContextualCompletion(query)) return false;
  const tokens = query.tokens || [];
  if (!tokens.length) return false;
  const last = tokens[tokens.length - 1];
  const typed = String(last.surfaceNormalized || last.surface || last.normalized || "").toLowerCase();
  if (!typed) return true;
  const meta = query.contextualCompletion;
  if (typed === meta?.completedToken || typed === meta?.canonicalToken) return false;
  const tail = query.lexicalTokens?.[query.lexicalTokens.length - 1];
  if (tail && (typed === tail.normalized || typed === tail.lemma)) return false;
  return true;
}

export function hasConfiguredSequenceIntent(query: AnalyzedQuery) {
  return Boolean(querySemanticFacts(query).configured.occupiedKey);
}

export function configuredPrefixRecallKey(query: AnalyzedQuery): string | null {
  const weak = querySemanticFacts(query).configured.weakRecall;
  if (weak?.ambiguity !== "unique") return null;
  return weak.candidates[0]?.key || null;
}

export function configuredPrefixRecallGroupKeys(query: AnalyzedQuery): string[] {
  const weak = querySemanticFacts(query).configured.weakRecall;
  if (weak?.ambiguity !== "group") return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of weak.candidates) {
    const key = row?.key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function configuredPrefixRecallKeys(query: AnalyzedQuery): string[] {
  const weak = querySemanticFacts(query).configured.weakRecall;
  if (!weak) return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of weak.candidates) {
    const key = row?.key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function documentHasConfiguredKey(doc: IndexedDocument, key: string, titleOnly: boolean) {
  if (doc.titleTokenSet.has(key) || doc.titleLemmaSet.has(key)) return true;
  if (titleOnly) return false;
  return doc.bodyTokenSet.has(key) || doc.bodyLemmaSet.has(key);
}

/** Unique recall: key in title or body. Ambiguous group recall: title key only. */
export function documentMatchesConfiguredPrefixKey(query: AnalyzedQuery, doc: IndexedDocument) {
  const weak = querySemanticFacts(query).configured.weakRecall;
  if (!weak) return false;
  if (weak.ambiguity === "unique") {
    const key = weak.candidates[0]?.key;
    return key ? documentHasConfiguredKey(doc, key, false) : false;
  }
  return weak.candidates.some((row) => row.key && documentHasConfiguredKey(doc, row.key, true));
}

export function hasConfiguredContentIdentity(query: AnalyzedQuery) {
  return Boolean(querySemanticFacts(query).configured.contentIdentityKey);
}

/**
 * Ranking may evaluate the configured concept and its authored peer forms.
 * Occupancy and configured-content identity stay distinct query facts; this is
 * their ranking-evidence union only. It does not set occupancy, rewrite
 * tokens, or mint configured aliases as typed phrases.
 */
export function hasConfiguredRankingIntent(query: AnalyzedQuery) {
  return hasConfiguredSequenceIntent(query) || hasConfiguredContentIdentity(query);
}

export function isStructuralWrapperTermConcept(concept: QueryConcept | null | undefined) {
  if (!concept || concept.kind !== "term") return false;
  if (STRUCTURAL_WRAPPER_STOP.has(String(concept.id || "").toLowerCase())) return true;
  return (concept.forms || []).some((form) => STRUCTURAL_WRAPPER_STOP.has(String(form || "").toLowerCase()));
}

/**
 * Narrow 2-character title-token prefix admission.
 * Activates only when the final typed token is a non-stop, non-digit stub of
 * length 2 and every other typed token is already in DEFAULT_STOP. Query
 * identity is unchanged; this is candidate evidence only.
 * Unambiguous configured occupancy already chose a concept; the typed spelling
 * must not admit extra prefix candidates (`io` must not retrieve IoT).
 */
export function shortTitleTokenPrefixStub(query: AnalyzedQuery): string | null {
  if (hasConfiguredSequenceIntent(query)) return null;
  const tokens = query.tokens || [];
  if (!tokens.length) return null;
  const stub = String(tokens[tokens.length - 1]?.normalized || "");
  if (stub.length !== 2 || isAllDigitToken(stub) || DEFAULT_STOP.has(stub)) return null;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!DEFAULT_STOP.has(String(tokens[i]?.normalized || ""))) return null;
  }
  return stub;
}

export function documentHasShortTitleTokenPrefix(query: AnalyzedQuery, doc: IndexedDocument): boolean {
  const stub = shortTitleTokenPrefixStub(query);
  if (!stub) return false;
  const store = asCompactStore(doc);
  if (store) {
    return compactTitleHasPrefixForm(store, compactOrdinal(doc), stub, (form, tok) =>
      Boolean(tok) && tok.startsWith(form) && !isAllDigitToken(tok)
    );
  }
  return (doc.titleTokens || []).some((tok) => tok.startsWith(stub) && !isAllDigitToken(tok));
}

export function standaloneRecallHint(query: AnalyzedQuery | null | undefined): StandaloneRecall | null {
  const hint = query?.standaloneRecall;
  if (!hint?.key || !hint.sourceToken) return null;
  return hint;
}

export function standaloneRecallConcept(query: AnalyzedQuery | null | undefined): QueryConcept | null {
  const hint = standaloneRecallHint(query);
  if (!hint) return null;
  return {
    id: hint.key,
    kind: "configured-concept",
    forms: Array.isArray(hint.forms) && hint.forms.length ? hint.forms : [hint.key],
    matchedForm: [],
    aliases: configuredPeerForms({
      aliases: hint.aliases,
      id: hint.key,
    } as QueryConcept).map((alias) => [...alias]),
    provenance: "standalone-recall",
  };
}

export function documentMatchesStandaloneRecall(query: AnalyzedQuery, doc: IndexedDocument) {
  const concept = standaloneRecallConcept(query);
  if (!concept) return false;
  return Boolean(conceptMatchesTitle(concept, doc) || conceptMatchesBody(concept, doc));
}

/**
 * Extra search-equivalence concepts attached after configured/phrase occupancy.
 * Distinct from ordinary term concepts whose synonym forms were merged into the
 * typed token (provenance may also be "synonym" on that merged concept).
 * Extra concepts have id === an equivalentRecall target and are not a recall source.
 */
export function isSearchEquivalenceRecallConcept(query: AnalyzedQuery | null | undefined, concept: QueryConcept | null | undefined) {
  if (!query || !concept || concept.kind === "configured-concept") return false;
  if (concept.provenance !== "synonym") return false;
  const pairs = query.equivalentRecall;
  if (!pairs?.length) return false;
  const id = concept.id;
  if (!id) return false;
  if (!pairs.some((pair) => pair.target === id)) return false;
  if (pairs.some((pair) => pair.source === id)) return false;
  return true;
}

export function searchEquivalenceRecallConcepts(query: AnalyzedQuery | null | undefined): QueryConcept[] {
  return (query?.concepts || []).filter((concept) => isSearchEquivalenceRecallConcept(query, concept));
}

export function coverageConcepts(query: AnalyzedQuery, concepts: QueryConcept[]) {
  return concepts.filter((concept) => !isSearchEquivalenceRecallConcept(query, concept));
}

/**
 * Coverage concepts for ranking. Occupancy already has no wrapper terms.
 * Identity-only queries may still carry WH/copula/determiner term concepts
 * (especially length-2 wraps); those must not count as concept coverage.
 */
export function rankingCoverageConcepts(query: AnalyzedQuery, concepts: QueryConcept[]) {
  const usable = coverageConcepts(query, concepts);
  if (!hasConfiguredRankingIntent(query)) return usable;
  return usable.filter((c) => !isStructuralWrapperTermConcept(c));
}

export function topicalRecallHint(query: AnalyzedQuery | null | undefined): TopicalRecall | null {
  const hint = query?.topicalRecall;
  if (!hint?.key || !Array.isArray(hint.forms) || !hint.forms.length) return null;
  return hint;
}

export type TopicalFormEvidence = {
  hit: boolean;
  title: boolean;
  phrase: boolean;
};

export function topicalFormEvidence(doc: IndexedDocument, form: string[]): TopicalFormEvidence {
  const tokens = (form || []).filter(Boolean);
  if (!tokens.length) return { hit: false, title: false, phrase: false };
  if (tokens.length === 1) {
    const token = tokens[0];
    const title = Boolean(doc.titleTokenSet.has(token) || doc.titleLemmaSet.has(token));
    const body = Boolean(doc.bodyTokenSet.has(token) || doc.bodyLemmaSet.has(token));
    return { hit: title || body, title, phrase: false };
  }
  const title = sequencePresent(tokens, doc.titleTokens) || sequencePresent(tokens, doc.titleLemmas);
  const body = sequencePresent(tokens, doc.bodyTokens) || sequencePresent(tokens, doc.bodyLemmas);
  return { hit: title || body, title, phrase: title || body };
}

/**
 * Indexed posting-union prefix walks must match full-scan field eligibility.
 *
 * Topical recall is exact token/lemma or exact multi-token sequence
 * (`topicalFormEvidence`). Synonym-recall, standalone-recall, and ordinary
 * concepts use `conceptMatchesTitle` / `conceptMatchesBody`, which admit title
 * `allowPrefixMatch` and body `form.length >= 3` `startsWith` evidence.
 * Acronym field evidence is exact/sequence; extra prefix walks are still
 * dropped by `retrievalSourcesForDocument` revalidation.
 */
export function retrievalFormKindAllowsPrefix(kind: string) {
  return kind !== "topical-recall" && kind !== "configured-prefix-recall";
}

export function matchedTopicalForms(query: AnalyzedQuery, doc: IndexedDocument): string[][] {
  const hint = topicalRecallHint(query);
  if (!hint) return [];
  const out: string[][] = [];
  for (const form of hint.forms) {
    if (topicalFormEvidence(doc, form).hit) out.push(form);
  }
  return out;
}

export function documentMatchesTopicalRecall(query: AnalyzedQuery, doc: IndexedDocument) {
  return matchedTopicalForms(query, doc).length > 0;
}

export function identityTokens(query: AnalyzedQuery): QueryToken[] {
  if (hasConfiguredSequenceIntent(query)) return query.tokens || [];
  if (query.lexicalTokens?.length) return query.lexicalTokens;
  return query.tokens || [];
}

export function unboundTypedTokens(query: AnalyzedQuery): QueryToken[] {
  if (hasConfiguredSequenceIntent(query)) return [];
  const tokens = query.tokens || [];
  if (!tokens.length || !shouldConsumeBoundTrailingToken(query)) return tokens;
  return tokens.slice(0, -1);
}

export function evidenceTokens(query: AnalyzedQuery): QueryToken[] {
  if (hasConfiguredSequenceIntent(query)) return [];
  const tokens = unboundTypedTokens(query);
  const weak = querySemanticFacts(query).configured.weakRecall;
  if (weak?.ambiguity !== "unique" || !tokens.length) return tokens;
  const last = tokens[tokens.length - 1];
  if (dropConfiguredPrefixRecallTrailingStop(last, weak.candidates[0])) {
    return tokens.slice(0, -1);
  }
  return tokens;
}

export function isBoundTrailingTypedToken(query: AnalyzedQuery, token: QueryToken) {
  const tokens = query.tokens || [];
  if (!tokens.length || !shouldConsumeBoundTrailingToken(query)) return false;
  return token === tokens[tokens.length - 1];
}

export function isBoundTrailingTermConcept(query: AnalyzedQuery, concept: QueryConcept) {
  if (!concept || concept.kind === "configured-concept") return false;
  const tokens = query.tokens || [];
  if (!tokens.length || !shouldConsumeBoundTrailingToken(query)) return false;
  const last = tokens[tokens.length - 1];
  const forms = new Set(
    [last.normalized, last.lemma, last.surfaceNormalized, last.surface].filter(
      (v): v is string => typeof v === "string" && v.length > 0
    )
  );
  return forms.has(concept.id);
}

function versionHit(query: AnalyzedQuery, doc: IndexedDocument): VersionHit | null {
  const numberConcepts = query.concepts.filter((c) => c.kind === "number");
  const dottedHit = query.dottedSpans.some((span) => doc.dottedSpans.includes(span));
  let compactHit = false;
  for (const tok of query.tokens) {
    if (queryTokenMatchesVersionCompact(tok.normalized, doc.versionCompactForms)) {
      compactHit = true;
      break;
    }
  }
  if (!compactHit && !dottedHit) return null;

  const companions = query.tokens.filter(
    (t) => !isAllDigitToken(t.normalized) && t.normalized.length >= 3
  );
  let companion: VersionCompanion = "none";
  if (companions.length === 0) companion = "absent";
  else {
    const ok = companions.some((c) => {
      const typed = typedForm(c);
      return doc.titleTokens.some((tok) => tok === typed || isNearCompletePrefix(typed, tok));
    });
    companion = ok ? "covered" : "weak";
  }

  return {
    compactHit,
    dottedHit,
    companion,
    numberConcepts: numberConcepts.length,
  };
}

function canonicalTokenEqual(qt: QueryToken, titleTok: string, titleLemma: string) {
  const n = qt.normalized;
  const lemma = qt.lemma || n;
  return n === titleTok || lemma === titleTok || n === titleLemma || lemma === titleLemma;
}

/**
 * Contextual title-sequence prefix. Preceding query tokens must align with the
 * start of the title exactly/canonically. Only the FINAL token may be a short
 * proper prefix of the aligned title token. Standalone stubs (ap, c, co) do
 * not qualify because they have no preceding context.
 */
export function matchContextualTitlePrefix(query: AnalyzedQuery, doc: IndexedDocument): ContextualTitlePrefix | null {
  const qToks = query.tokens || [];
  const titleToks = doc.titleTokens || [];
  const titleLemmas = doc.titleLemmas || [];
  if (qToks.length < 2 || titleToks.length < 2) return null;
  if (qToks.length > titleToks.length) return null;

  const last = qToks.length - 1;
  const matchedPrefixTokens: string[] = [];
  for (let i = 0; i < last; i++) {
    const titleTok = titleToks[i];
    const titleLemma = titleLemmas[i] || "";
    if (!titleTok || !canonicalTokenEqual(qToks[i], titleTok, titleLemma)) return null;
    matchedPrefixTokens.push(qToks[i].normalized);
  }

  const qLast = qToks[last];
  const tLast = titleToks[last];
  const lLast = titleLemmas[last] || "";
  if (!qLast || !tLast) return null;
  const prefix = qLast.normalized;
  if (!prefix) return null;
  if (isAllDigitToken(prefix) || isAllDigitToken(tLast)) return null;

  const aligned = tLast.startsWith(prefix) ? tLast : lLast.startsWith(prefix) ? lLast : "";
  if (!aligned || aligned === prefix || !aligned.startsWith(prefix)) return null;

  const unmatchedTitleTokensAfter = Math.max(0, titleToks.length - qToks.length);
  const completeness = prefix.length / Math.max(aligned.length, 1);
  const titleSequenceTightness = 1 / (1 + unmatchedTitleTokensAfter);
  return {
    matchedPrefixTokens,
    activeFinalPrefix: prefix,
    completedTitleToken: aligned,
    unmatchedTitleTokensAfter,
    titleSequenceTightness: Number(titleSequenceTightness.toFixed(4)),
    contextualPrefixQuality: Number((completeness * titleSequenceTightness).toFixed(4)),
  };
}

export function occupiedTitleJoins(query: AnalyzedQuery): string[] {
  const acr = (query.concepts || []).find((c) => c.kind === "configured-concept");
  if (!acr || !hasConfiguredSequenceIntent(query)) return [];
  const joins = new Set<string>();
  if (acr.id) joins.add(acr.id);
  for (const form of configuredPeerForms(acr)) {
    if (form.length) joins.add(form.join(" "));
  }
  const coverage = acr.formCoverage;
  if (typeof coverage === "number" && coverage < 1) {
    const typed = (query.tokens || []).map((t) => t.normalized).filter(Boolean).join(" ");
    if (typed) joins.add(typed);
  }
  return [...joins].sort();
}

function occupiedOneTokenFormPrefixHit(query: AnalyzedQuery, doc: IndexedDocument) {
  const acr = (query.concepts || []).find((c) => c.kind === "configured-concept");
  if (!acr || !hasConfiguredSequenceIntent(query)) return false;
  for (const form of configuredPeerForms(acr)) {
    if (form.length !== 1) continue;
    const tok = form[0];
    if (!tok || DEFAULT_STOP.has(tok) || isAllDigitToken(tok)) continue;
    if (doc.titleTokens.some((titleTok) => allowPrefixMatch(tok, titleTok))) return true;
  }
  return false;
}

function scanDocument(
  query: AnalyzedQuery,
  doc: IndexedDocument,
  add: (doc: IndexedDocument, source: string) => void
) {
  const identity = identityTokens(query);
  const occupiedJoins = occupiedTitleJoins(query);
  if (occupiedJoins.length) {
    if (occupiedJoins.includes(doc.normalizedTitle)) add(doc, "exact-title");
    else if (occupiedJoins.some((join) => join && doc.normalizedTitle.startsWith(join))) add(doc, "title-prefix");
  } else {
    if (doc.normalizedTitle === identity.map((t) => t.normalized).join(" ")) {
      add(doc, "exact-title");
    }
    const qNorm = identity.map((t) => t.normalized).join(" ");
    if (qNorm && doc.normalizedTitle.startsWith(qNorm)) add(doc, "title-prefix");
  }
  const prefixHit = hasConfiguredSequenceIntent(query)
    ? occupiedOneTokenFormPrefixHit(query, doc)
    : doc.titleTokens.some((tok) =>
        evidenceTokens(query).some((t) => allowPrefixMatch(t.normalized, tok))
      ) || documentHasShortTitleTokenPrefix(query, doc);
  if (prefixHit) {
    add(doc, "title-token-prefix");
  }

  for (const concept of query.concepts) {
    if (isBoundTrailingTermConcept(query, concept)) continue;
    if (isSearchEquivalenceRecallConcept(query, concept)) {
      if (conceptMatchesTitle(concept, doc)) add(doc, "equivalent-recall");
      continue;
    }
    const kind = conceptMatchesTitle(concept, doc);
    if (concept.kind === "configured-concept") {
      if (kind) add(doc, "configured-concept");
      continue;
    }
    if (kind === "exact") add(doc, "title-token");
    else if (kind === "prefix") add(doc, "title-prefix");
    else if (kind === "lemma") add(doc, "morphology");
  }

  const v = versionHit(query, doc);
  if (v) add(doc, "version");

  for (const concept of query.concepts) {
    if (isBoundTrailingTermConcept(query, concept)) continue;
    if (isSearchEquivalenceRecallConcept(query, concept)) {
      if (conceptMatchesBody(concept, doc)) add(doc, "equivalent-recall");
      continue;
    }
    if (conceptMatchesBody(concept, doc)) add(doc, "body-lexical");
  }

  if (!hasConfiguredSequenceIntent(query) && matchContextualTitlePrefix(query, doc)) {
    add(doc, "contextual-title-prefix");
  }

  if (documentMatchesStandaloneRecall(query, doc)) {
    add(doc, "standalone-recall");
  }

  if (documentMatchesTopicalRecall(query, doc)) {
    add(doc, "topical-recall");
  }

  if (documentMatchesConfiguredPrefixKey(query, doc)) {
    add(doc, "configured-prefix-recall");
  }
}

function createHitBag() {
  const byId = new Map<string, RetrievalHit>();
  function add(doc: IndexedDocument, source: string) {
    let hit = byId.get(doc.id);
    if (!hit) {
      hit = { document: doc, retrievalSources: [] };
      byId.set(doc.id, hit);
    }
    if (!hit.retrievalSources.includes(source)) hit.retrievalSources.push(source);
  }
  return { byId, add };
}

/**
 * Deterministic full-scan retrievers. Each hit records provenance only;
 * none assign ranking scores.
 */
export function retrieveCandidates(query: AnalyzedQuery, index: SearchIndex, { signal }: RetrieveOptions = {}): RetrievalHit[] {
  const { byId, add } = createHitBag();
  const docs = index.documents || [];
  for (let i = 0; i < docs.length; i++) {
    if (i % 8 === 0) throwIfAborted(signal);
    scanDocument(query, docs[i], add);
  }
  return [...byId.values()];
}

export async function retrieveCandidatesAsync(query: AnalyzedQuery, index: SearchIndex, { signal }: RetrieveOptions = {}): Promise<RetrievalHit[]> {
  const { byId, add } = createHitBag();
  const docs = index.documents || [];
  for (let i = 0; i < docs.length; i++) {
    if (i % 8 === 0) {
      throwIfAborted(signal);
      await Promise.resolve();
      throwIfAborted(signal);
    }
    scanDocument(query, docs[i], add);
  }
  return [...byId.values()];
}

/** Exact full-scan provenance for one document. Empty means the document is not a hit. */
export function retrievalSourcesForDocument(query: AnalyzedQuery, doc: IndexedDocument): string[] {
  const sources: string[] = [];
  scanDocument(query, doc, (_d, source) => {
    if (!sources.includes(source)) sources.push(source);
  });
  return sources;
}

export { versionHit, conceptMatchesTitle, conceptMatchesBody };
