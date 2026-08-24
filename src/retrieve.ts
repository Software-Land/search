import { isNearCompletePrefix, allowPrefixMatch } from "./text.js";
import {
  isAllDigitToken,
  queryTokenMatchesVersionCompact,
  hasIndependentTitleForm,
} from "./versionForms.js";
import { throwIfAborted } from "./cancel.js";
import {
  asCompactStore,
  compactBodyMatchesConcept,
  compactHasIndependentTitleForm,
  compactOrdinal,
  compactTitleHasLemma,
  compactTitleHasPrefixForm,
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
 * body tokens are not full configured-equivalence evidence.
 * A single expansion word is never full multi-token equivalence evidence,
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
    if (!form || /^\d+$/.test(form)) return false;
    return !list.some((other) => other !== form && other.startsWith(form) && other.length > form.length);
  });
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
  const store = asCompactStore(doc);
  if (store) {
    const ordinal = compactOrdinal(doc);
    for (const form of concept.forms) {
      if (compactHasIndependentTitleForm(store, ordinal, form)) return "exact";
      if (compactTitleHasLemma(store, ordinal, form)) return "lemma";
    }
    for (const form of titlePrefixableForms(concept.forms)) {
      if (compactTitleHasPrefixForm(store, ordinal, form, allowPrefixMatch)) return "prefix";
    }
    return null;
  }
  for (const form of concept.forms) {
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
  const store = asCompactStore(doc);
  if (store) return compactBodyMatchesConcept(store, compactOrdinal(doc), concept.forms || []);
  for (const form of concept.forms) {
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
    )
  ) {
    add(doc, "title-token-prefix");
  }

  for (const concept of query.concepts) {
    if (isBoundTrailingTermConcept(query, concept)) continue;
    const kind = conceptMatchesTitle(concept, doc);
    if (concept.kind === "acronym") {
      if (kind) add(doc, "configured-equivalence");
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
    if (conceptMatchesBody(concept, doc)) add(doc, "body-lexical");
  }

  if (!hasConfiguredSequenceIntent(query) && matchContextualTitlePrefix(query, doc)) {
    add(doc, "contextual-title-prefix");
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
