import { isNearCompletePrefix, allowPrefixMatch } from "./text.js";
import {
  isAllDigitToken,
  queryTokenMatchesVersionCompact,
} from "./versionForms.js";
import { throwIfAborted } from "./cancel.js";

/** @param {string[]} needles @param {string[]} hay */
function sequencePresent(needles, hay) {
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

/** @param {import("./types.js").QueryConcept} concept */
function expansionSequence(concept) {
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
/** @param {string[]} seq @param {string[]} expansion */
function isSingleExpansionWordAlias(seq, expansion) {
  return expansion.length >= 2 && seq.length === 1 && expansion.includes(seq[0]);
}

/** @param {string[]} expansion @param {string[]} tokens @param {string[]} lemmas @param {Set<string>} tokenSet @param {Set<string>} lemmaSet @param {{ requireContiguous?: boolean }} [opts] */
function fieldHasExpansionEvidence(expansion, tokens, lemmas, tokenSet, lemmaSet, { requireContiguous = false } = {}) {
  if (!expansion.length) return false;
  if (expansion.length === 1) {
    return tokenSet.has(expansion[0]) || lemmaSet.has(expansion[0]);
  }
  if (sequencePresent(expansion, tokens) || sequencePresent(expansion, lemmas)) return true;
  if (requireContiguous) return false;
  return expansion.every((f) => tokenSet.has(f) || lemmaSet.has(f));
}

/** @param {import("./types.js").QueryConcept} concept @param {string[]} tokens @param {string[]} lemmas @param {Set<string>} tokenSet @param {Set<string>} lemmaSet @param {{ requireContiguous?: boolean }} [opts] */
function acronymFieldEvidence(concept, tokens, lemmas, tokenSet, lemmaSet, opts = {}) {
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
 * @param {import("./types.js").QueryConcept} concept
 * @param {import("./types.js").IndexedDocument} doc
 * @returns {"key" | "expansion" | "exact" | "prefix" | "lemma" | null}
 */
function conceptMatchesTitle(concept, doc) {
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
  for (const form of concept.forms) {
    if (doc.titleTokenSet.has(form) || doc.titleLemmaSet.has(form)) return "exact";
    if (/^\d+$/.test(form)) continue;
    for (const tok of doc.titleTokens) {
      if (allowPrefixMatch(form, tok)) return "prefix";
    }
    for (const tok of doc.titleLemmas) {
      if (form === tok) return "lemma";
    }
  }
  return null;
}

/** @param {import("./types.js").QueryConcept} concept @param {import("./types.js").IndexedDocument} doc */
function conceptMatchesBody(concept, doc) {
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

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function versionHit(query, doc) {
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
  let companion = "none";
  if (companions.length === 0) companion = "absent";
  else {
    const ok = companions.some((c) =>
      doc.titleTokens.some(
        (tok) => tok === c.normalized || tok === c.lemma || isNearCompletePrefix(c.normalized, tok)
      )
    );
    companion = ok ? "covered" : "weak";
  }

  return {
    compactHit,
    dottedHit,
    companion,
    numberConcepts: numberConcepts.length,
  };
}

/** @param {import("./types.js").QueryToken} qt @param {string} titleTok @param {string} titleLemma */
function canonicalTokenEqual(qt, titleTok, titleLemma) {
  const n = qt.normalized;
  const lemma = qt.lemma || n;
  return n === titleTok || lemma === titleTok || n === titleLemma || lemma === titleLemma;
}

/**
 * Contextual title-sequence prefix. Preceding query tokens must align with the
 * start of the title exactly/canonically. Only the FINAL token may be a short
 * proper prefix of the aligned title token. Standalone stubs (ap, c, co) do
 * not qualify because they have no preceding context.
 *
 * @param {import("./types.js").AnalyzedQuery} query
 * @param {import("./types.js").IndexedDocument} doc
 * @returns {import("./types.js").ContextualTitlePrefix | null}
 */
export function matchContextualTitlePrefix(query, doc) {
  const qToks = query.tokens || [];
  const titleToks = doc.titleTokens || [];
  const titleLemmas = doc.titleLemmas || [];
  if (qToks.length < 2 || titleToks.length < 2) return null;
  if (qToks.length > titleToks.length) return null;

  const last = qToks.length - 1;
  /** @type {string[]} */
  const matchedPrefixTokens = [];
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

/**
 * @param {import("./types.js").AnalyzedQuery} query
 * @param {import("./types.js").IndexedDocument} doc
 * @param {(doc: import("./types.js").IndexedDocument, source: string) => void} add
 */
function scanDocument(query, doc, add) {
  if (doc.normalizedTitle === query.tokens.map((t) => t.normalized).join(" ")) {
    add(doc, "exact-title");
  }

  const qNorm = query.tokens.map((t) => t.normalized).join(" ");
  if (qNorm && doc.normalizedTitle.startsWith(qNorm)) add(doc, "title-prefix");
  if (
    doc.titleTokens.some((tok) =>
      query.tokens.some((t) => allowPrefixMatch(t.normalized, tok))
    )
  ) {
    add(doc, "title-token-prefix");
  }

  for (const concept of query.concepts) {
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
    if (conceptMatchesBody(concept, doc)) add(doc, "body-lexical");
  }

  if (matchContextualTitlePrefix(query, doc)) add(doc, "contextual-title-prefix");
}

function createHitBag() {
  /** @type {Map<string, import("./types.js").RetrievalHit>} */
  const byId = new Map();
  /**
   * @param {import("./types.js").IndexedDocument} doc
   * @param {string} source
   */
  function add(doc, source) {
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
 * @param {import("./types.js").AnalyzedQuery} query
 * @param {import("./types.js").SearchIndex} index
 * @param {import("./types.js").RetrieveOptions} [options]
 * @returns {import("./types.js").RetrievalHit[]}
 */
export function retrieveCandidates(query, index, { signal } = {}) {
  const { byId, add } = createHitBag();
  const docs = index.documents || [];
  for (let i = 0; i < docs.length; i++) {
    if (i % 8 === 0) throwIfAborted(signal);
    scanDocument(query, docs[i], add);
  }
  return [...byId.values()];
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").SearchIndex} index @param {import("./types.js").RetrieveOptions} [options] */
export async function retrieveCandidatesAsync(query, index, { signal } = {}) {
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

export { versionHit, conceptMatchesTitle, conceptMatchesBody };
