import { isNearCompletePrefix, allowPrefixMatch, DEFAULT_STOP } from "./text.js";
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

type ConceptTitleMatch = "key" | "expansion" | "exact" | "prefix" | "lemma";
type VersionCompanion = "none" | "absent" | "covered" | "weak";

interface VersionHit {
  compactHit: boolean;
  dottedHit: boolean;
  companion: VersionCompanion;
  numberConcepts: number;
}

function sequencePresent(needles: string[], hay: string[]) {
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

function expansionSequence(concept: QueryConcept) {
  if (Array.isArray(concept.expansion) && concept.expansion.length) {
    return concept.expansion.filter((f) => f && f !== concept.id && !/^\d+$/.test(f));
  }
  return (concept.forms || []).filter((f) => f !== concept.id && !/^\d+$/.test(f));
}

/**
 * Multi-token expansions require the expansion as a contiguous phrase.
 * Title fields may also accept a complete token set (short titles).
 * Body fields require a contiguous normalized expansion phrase — dispersed
 * body tokens are not full configured-concept evidence.
 * A single expansion word is never full multi-token configured-concept evidence,
 * including a 1-token alias that is just one of the expansion words.
 */
function isSingleExpansionWordAlias(seq: string[], expansion: string[]) {
  return expansion.length >= 2 && seq.length === 1 && expansion.includes(seq[0]);
}

function fieldHasExpansionEvidence(
  expansion: string[],
  tokens: string[],
  lemmas: string[],
  tokenSet: Set<string>,
  lemmaSet: Set<string>,
  { requireContiguous = false }: { requireContiguous?: boolean } = {}
) {
  if (!expansion.length) return false;
  if (expansion.length === 1) {
    return tokenSet.has(expansion[0]) || lemmaSet.has(expansion[0]);
  }
  if (sequencePresent(expansion, tokens) || sequencePresent(expansion, lemmas)) return true;
  if (requireContiguous) return false;
  return expansion.every((f) => tokenSet.has(f) || lemmaSet.has(f));
}

function acronymFieldEvidence(
  concept: QueryConcept,
  tokens: string[],
  lemmas: string[],
  tokenSet: Set<string>,
  lemmaSet: Set<string>,
  opts: { requireContiguous?: boolean } = {}
) {
  if (tokenSet.has(concept.id) || lemmaSet.has(concept.id)) return true;
  const expansion = expansionSequence(concept);
  if (fieldHasExpansionEvidence(expansion, tokens, lemmas, tokenSet, lemmaSet, opts)) return true;
  for (const alias of concept.aliases || []) {
    const seq = (alias || []).filter((f) => f && !/^\d+$/.test(f));
    if (isSingleExpansionWordAlias(seq, expansion)) continue;
    if (fieldHasExpansionEvidence(seq, tokens, lemmas, tokenSet, lemmaSet, opts)) return true;
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
  if (concept.kind === "acronym") {
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
      return "expansion";
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
  if (concept.kind === "acronym") {
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
 * Unique contextual expansion completion binds the trailing typed token to one
 * configured expansion word. The typed stub stays on the query for explain;
 * it must not independently generate unbound lexical evidence unless the user
 * already typed that completed word or its canonical lemma (`learn` of
 * `learning`). Short proper prefixes (`sec`, `prot`, `l`) are consumed.
 */
export function hasBoundContextualCompletion(query: AnalyzedQuery) {
  return Boolean(query.contextualCompletion?.completedToken);
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
  return Boolean(query.configuredSequenceIntent?.key);
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
    kind: "acronym",
    forms: Array.isArray(hint.forms) && hint.forms.length ? hint.forms : [hint.key, ...(hint.expansion || [])],
    expansion: [...(hint.expansion || [])],
    aliases: (hint.aliases || []).map((alias) => [...alias]),
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
  if (!query || !concept || concept.kind === "acronym") return false;
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
  return kind !== "topical-recall";
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
  if (hasConfiguredSequenceIntent(query) && query.lexicalTokens?.length) {
    return query.lexicalTokens;
  }
  return query.tokens || [];
}

export function unboundTypedTokens(query: AnalyzedQuery): QueryToken[] {
  if (hasConfiguredSequenceIntent(query)) return [];
  const tokens = query.tokens || [];
  if (!tokens.length || !shouldConsumeBoundTrailingToken(query)) return tokens;
  return tokens.slice(0, -1);
}

export function evidenceTokens(query: AnalyzedQuery): QueryToken[] {
  if (hasConfiguredSequenceIntent(query) && query.lexicalTokens?.length) {
    return query.lexicalTokens;
  }
  return unboundTypedTokens(query);
}

export function isBoundTrailingTypedToken(query: AnalyzedQuery, token: QueryToken) {
  const tokens = query.tokens || [];
  if (!tokens.length || !shouldConsumeBoundTrailingToken(query)) return false;
  return token === tokens[tokens.length - 1];
}

export function isBoundTrailingTermConcept(query: AnalyzedQuery, concept: QueryConcept) {
  if (!concept || concept.kind === "acronym") return false;
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

function scanDocument(
  query: AnalyzedQuery,
  doc: IndexedDocument,
  add: (doc: IndexedDocument, source: string) => void
) {
  const identity = identityTokens(query);
  if (doc.normalizedTitle === identity.map((t) => t.normalized).join(" ")) {
    add(doc, "exact-title");
  }

  const qNorm = identity.map((t) => t.normalized).join(" ");
  if (qNorm && doc.normalizedTitle.startsWith(qNorm)) add(doc, "title-prefix");
  const unbound = evidenceTokens(query);
  if (
    doc.titleTokens.some((tok) =>
      unbound.some((t) => allowPrefixMatch(t.normalized, tok))
    ) ||
    documentHasShortTitleTokenPrefix(query, doc)
  ) {
    add(doc, "title-token-prefix");
  }

  for (const concept of query.concepts) {
    if (isBoundTrailingTermConcept(query, concept)) continue;
    if (isSearchEquivalenceRecallConcept(query, concept)) {
      if (conceptMatchesTitle(concept, doc)) add(doc, "equivalent-recall");
      continue;
    }
    const kind = conceptMatchesTitle(concept, doc);
    if (concept.kind === "acronym") {
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
