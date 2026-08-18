import { isNearCompletePrefix, allowPrefixMatch } from "./text.js";
import {
  isAllDigitToken,
  queryTokenMatchesVersionCompact,
} from "./versionForms.js";
import { throwIfAborted } from "./cancel.js";

/** @param {import("./types.js").QueryConcept} concept @param {import("./types.js").IndexedDocument} doc */
function conceptMatchesTitle(concept, doc) {
  if (concept.kind === "acronym") {
    if (doc.titleTokenSet.has(concept.id) || doc.titleLemmaSet.has(concept.id)) return "exact";
    const expansion = concept.forms.filter((f) => f !== concept.id && !/^\d+$/.test(f));
    const hits = expansion.filter((f) => doc.titleTokenSet.has(f) || doc.titleLemmaSet.has(f));
    if (expansion.length >= 2) {
      if (hits.length >= 2 && hits.length / expansion.length >= 0.5) return "exact";
      return null;
    }
    if (hits.length) return "exact";
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
    if (kind === "exact") add(doc, concept.kind === "acronym" ? "configured-equivalence" : "title-token");
    else if (kind === "prefix") add(doc, "title-prefix");
    else if (kind === "lemma") add(doc, "morphology");
    if (concept.kind === "acronym" && kind) add(doc, "configured-equivalence");
  }

  const v = versionHit(query, doc);
  if (v) add(doc, "version");

  for (const concept of query.concepts) {
    if (conceptMatchesBody(concept, doc)) add(doc, "body-lexical");
  }
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
