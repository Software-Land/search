import {
  cleanText,
  tokenize,
  acronymKey,
  isPlausibleAcronymKey,
  isProtectedLiteral,
  expansionTokens,
  contentTokens,
  initialsMatch,
  initialsMatchCooccurrence,
  COOCCURRENCE_OPTIONAL,
  phraseKey,
  normalizeExpansion,
  looksLikeTermPhrase,
  FUNCTION_WORDS,
} from "./text.js";

const PHRASE_THEN_ACR =
  /\b((?:[A-Za-z][A-Za-z0-9+#]*|[A-Z]{2,})(?:[\s\/,-]+(?:(?:of|the|and|a|an|for|as|to|in|or)\s+)?[A-Za-z][A-Za-z0-9+#]*){1,7})\s*\(\s*([A-Za-z][A-Za-z0-9+.-]{1,12})\s*\)/g;

const ACR_THEN_PHRASE =
  /\b([A-Za-z][A-Za-z0-9+.-]{1,12})\s*\(\s*((?:[A-Za-z][A-Za-z0-9+#]*|[A-Z]{2,})(?:[\s\/,-]+(?:(?:of|the|and|a|an|for|as|to|in|or)\s+)?[A-Za-z][A-Za-z0-9+#]*){1,7})\s*\)/g;

const STANDS_FOR =
  /\b([A-Za-z][A-Za-z0-9+.-]{1,12})\s+(?:is an abbreviation for|stands for|is short for|is an acronym for)\s+([^.;:\n]{5,80})/gi;

const DASH_EXPANSION =
  /\b([A-Z][A-Za-z0-9]{1,11})\s*[–—-]\s*([A-Z][a-zA-Z0-9]*(?:[\s\/]+(?:(?:of|the|and|a|an|for|as|to|in|or)\s+)?[A-Z][a-zA-Z0-9]*){1,7})/g;

const WEAK_LAST_TOKENS = new Set([
  "strong", "new", "high", "low", "easy", "easier", "good", "bad", "real",
  "true", "false", "simple", "hard", "first", "last", "next", "same",
]);

/** @param {string[]} tokens */
function looksLikePhrase(tokens) {
  const content = contentTokens(tokens);
  if (content.length < 2) return false;
  if (tokens.length > 8) return false;
  return content.every((t) => t.length >= 2);
}

/** @param {{ key: string, expansion: unknown, docId: string, field: string, snippet: unknown, provenance: string, originalKey?: unknown }} opts */
function makeCandidate({ key, expansion, docId, field, snippet, provenance, originalKey }) {
  const tokens = normalizeExpansion(expansionTokens(expansion));
  if (!looksLikePhrase(tokens) && !(tokens.length === 1 && tokens[0].length >= 8 && key.length >= 3)) {
    return null;
  }
  if (!isPlausibleAcronymKey(key, { original: originalKey || key })) return null;
  if (isProtectedLiteral(key) && tokens.length > 1) {
    if (!initialsMatch(key, tokens)) return null;
  }
  const match = initialsMatch(key, tokens);
  return {
    type: "equivalence-candidate",
    key,
    expansion: tokens,
    expansionPhrase: phraseKey(tokens),
    initialsMatch: match,
    evidenceHit: {
      documentId: docId,
      field,
      provenance,
      snippet: String(snippet || "").slice(0, 160),
    },
  };
}

/** @param {Map<string, import("../types.js").EquivalenceCandidate>} bag @param {ReturnType<typeof makeCandidate>} cand */
function pushHit(bag, cand) {
  if (!cand) return;
  const id = `${cand.key}::${cand.expansionPhrase}`;
  let row = bag.get(id);
  if (!row) {
    row = {
      type: "equivalence-candidate",
      key: cand.key,
      expansion: cand.expansion,
      expansionPhrase: cand.expansionPhrase,
      initialsMatch: cand.initialsMatch,
      hits: [],
    };
    bag.set(id, row);
  }
  row.hits = row.hits || [];
  row.hits.push(cand.evidenceHit);
}

/** @param {import("../types.js").CorpusDocument[]} documents */
export function mineExplicitDefinitions(documents) {
  const bag = new Map();
  for (const doc of documents) {
    for (const field of ["title", "body"]) {
      const text = cleanText(doc[field]);
      if (!text) continue;
      PHRASE_THEN_ACR.lastIndex = 0;
      ACR_THEN_PHRASE.lastIndex = 0;
      STANDS_FOR.lastIndex = 0;
      DASH_EXPANSION.lastIndex = 0;

      let m;
      while ((m = PHRASE_THEN_ACR.exec(text))) {
        pushHit(
          bag,
          makeCandidate({
            key: acronymKey(m[2]),
            originalKey: m[2],
            expansion: m[1],
            docId: doc.id,
            field,
            snippet: m[0],
            provenance: "explicit-parenthetical-definition",
          })
        );
      }
      while ((m = ACR_THEN_PHRASE.exec(text))) {
        const key = acronymKey(m[1]);
        const expansion = m[2];
        if (tokenize(expansion).length < 2 && acronymKey(expansion) === key) continue;
        pushHit(
          bag,
          makeCandidate({
            key,
            originalKey: m[1],
            expansion,
            docId: doc.id,
            field,
            snippet: m[0],
            provenance: "explicit-parenthetical-definition",
          })
        );
      }
      while ((m = STANDS_FOR.exec(text))) {
        pushHit(
          bag,
          makeCandidate({
            key: acronymKey(m[1]),
            originalKey: m[1],
            expansion: m[2],
            docId: doc.id,
            field,
            snippet: m[0],
            provenance: "explicit-prose-definition",
          })
        );
      }
      while ((m = DASH_EXPANSION.exec(text))) {
        pushHit(
          bag,
          makeCandidate({
            key: acronymKey(m[1]),
            originalKey: m[1],
            expansion: m[2],
            docId: doc.id,
            field,
            snippet: m[0],
            provenance: "explicit-dash-definition",
          })
        );
      }
    }
  }
  return [...bag.values()];
}

/** @param {string[]} tokens @param {number} min @param {number} max */
function ngrams(tokens, min, max) {
  const out = [];
  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      out.push(tokens.slice(i, i + n));
    }
  }
  return out;
}

/** @param {unknown} text @returns {string[]} */
export function extractAcronymSurfaces(text) {
  const found = [];
  const re = /\b[A-Z][A-Za-z0-9]{1,7}\b/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const s = m[0];
    if (s.length > 8) continue;
    if (/^[A-Z][a-z]+$/.test(s)) continue;
    const upper = (s.match(/[A-Z]/g) || []).length;
    if (upper < 2) continue;
    found.push(s);
  }
  return found;
}

/**
 * Tokenize once. Classification and co-occurrence both reuse this.
 * @param {import("../types.js").CorpusDocument[]} documents
 * @returns {import("../types.js").IndexedDocument[]}
 */
export function indexDocuments(documents) {
  return documents.map((doc) => {
    const title = tokenize(doc.title);
    const body = tokenize(doc.body);
    const all = title.concat(body);
    return {
      id: doc.id,
      title,
      body,
      titleSet: new Set(title),
      allSet: new Set(all),
      titleAcronymKeys: new Set(title.map((t) => acronymKey(t)).filter(Boolean)),
      allAcronymKeys: new Set(all.map((t) => acronymKey(t)).filter(Boolean)),
      titleJoined: ` ${title.join(" ")} `,
      allJoined: ` ${all.join(" ")} `,
    };
  });
}

/** @param {import("../types.js").IndexedDocument} idx @param {string} key @param {string[]} expansion */
export function documentSupportsPairIndexed(idx, key, expansion) {
  const hasKey = idx.allSet.has(key) || idx.allAcronymKeys.has(key);
  if (!hasKey) {
    return { hasKey: false, titleHasKey: false, hasPhrase: false, titleHasPhrase: false };
  }
  const phrase = ` ${phraseKey(expansion)} `;
  return {
    hasKey: true,
    titleHasKey: idx.titleSet.has(key) || idx.titleAcronymKeys.has(key),
    hasPhrase: idx.allJoined.includes(phrase),
    titleHasPhrase: idx.titleJoined.includes(phrase),
  };
}

/** @param {import("../types.js").CorpusDocument} doc @param {string} key @param {string[]} expansion */
export function documentSupportsPair(doc, key, expansion) {
  const idx = indexDocuments([doc])[0];
  return documentSupportsPairIndexed(idx, key, expansion);
}

/**
 * Conservative co-occurrence: all-caps acronym surfaces × noun-phrase ngrams
 * whose initials match *after* normalization. Indexed by initials so this is
 * O(ngrams + acronyms) per document, not O(acronyms × ngrams).
 * @param {import("../types.js").CorpusDocument[]} documents
 * @param {{ titlePhrases?: Set<string> }} [opts]
 */
export function mineInitialismCooccurrence(documents, { titlePhrases } = {}) {
  const titleSet = titlePhrases || new Set();
  const phraseDf = new Map();
  const prepared = [];

  for (const doc of documents) {
    const titleToks = tokenize(doc.title);
    const bodyToks = tokenize(doc.body);
    const allToks = titleToks.concat(bodyToks);
    const phraseToTokens = /** @type {Map<string, string[]>} */ (new Map());
    for (const gram of ngrams(allToks, 2, 6)) {
      const tokens = normalizeExpansion(gram);
      if (!looksLikeTermPhrase(tokens)) continue;
      if (WEAK_LAST_TOKENS.has(tokens[tokens.length - 1])) continue;
      phraseToTokens.set(phraseKey(tokens), tokens);
    }
    for (const phrase of phraseToTokens.keys()) {
      phraseDf.set(phrase, (phraseDf.get(phrase) || 0) + 1);
    }

    const titleSurfaces = extractAcronymSurfaces(doc.title);
    const bodySurfaces = extractAcronymSurfaces(doc.body);
    const titleKeys = new Set(
      titleSurfaces.map((s) => acronymKey(s)).filter((k) => k && !FUNCTION_WORDS.has(k) && !isProtectedLiteral(k))
    );
    const acronyms = [];
    for (const surface of titleSurfaces.concat(bodySurfaces)) {
      const key = acronymKey(surface);
      if (!isPlausibleAcronymKey(key, { original: surface })) continue;
      if (isProtectedLiteral(key) || FUNCTION_WORDS.has(key)) continue;
      if (key.length < 3 && !titleKeys.has(key)) continue;
      acronyms.push(key);
    }

    const byInitials = /** @type {Map<string, Array<{ phrase: string, tokens: string[] }>>} */ (new Map());
    for (const [phrase, tokens] of phraseToTokens) {
      const skipped = tokens.filter((t) => !COOCCURRENCE_OPTIONAL.has(t)).map((t) => t[0] || "").join("");
      const strict = tokens.map((t) => t[0] || "").join("");
      for (const init of new Set([strict, skipped])) {
        if (!init || init.length < 2 || init.length > 8) continue;
        if (!byInitials.has(init)) byInitials.set(init, []);
        (byInitials.get(init) || []).push({ phrase, tokens });
      }
    }

    prepared.push({
      doc,
      titleToks,
      titleKeys,
      acronyms: [...new Set(acronyms)],
      byInitials,
    });
  }

  const bag = new Map();
  for (const row of prepared) {
    for (const key of row.acronyms) {
      const matches = row.byInitials.get(key) || [];
      for (const { phrase, tokens } of matches) {
        if (!initialsMatchCooccurrence(key, tokens)) continue;
        const independent = titleSet.has(phrase) || (phraseDf.get(phrase) || 0) >= 2;
        const titleHasKey = row.titleKeys.has(key);
        const inTitle = titleSet.has(phrase) || containsSequence(row.titleToks, tokens);
        if (!inTitle && !titleHasKey && !independent) continue;
        const id = `${key}::${phrase}`;
        let item = bag.get(id);
        if (!item) {
          item = {
            type: "equivalence-candidate",
            key,
            expansion: tokens,
            expansionPhrase: phrase,
            initialsMatch: true,
            hits: [],
          };
          bag.set(id, item);
        }
        if (item.hits && item.hits.length >= 8) continue;
        item.hits = item.hits || [];
        item.hits.push({
          documentId: row.doc.id,
          field: titleHasKey ? "title" : "body",
          provenance: inTitle ? "title-cooccurrence" : independent ? "corpus-frequency" : "initialism",
          snippet: phrase,
        });
      }
    }
  }
  return [...bag.values()];
}

/** @param {import("../types.js").CorpusDocument[]} documents @returns {Set<string>} */
export function collectPhraseInventory(documents) {
  const phrases = new Set();
  for (const doc of documents) {
    const titleToks = tokenize(doc.title);
    for (const gram of ngrams(titleToks, 2, 6)) {
      const tokens = normalizeExpansion(gram);
      if (tokens.length >= 2) phrases.add(phraseKey(tokens));
    }
  }
  return phrases;
}

/** @param {string[]} tokens @param {string[]} seq */
function containsSequence(tokens, seq) {
  if (!seq.length) return false;
  for (let i = 0; i + seq.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < seq.length; j++) {
      if (tokens[i + j] !== seq[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}
