/**
 * Old-vs-new public search() differentials for the packed ordinary path.
 * searchDetailed remains the FeatureVector oracle.
 */
import {
  SearchEngine,
  compileAuthoredRelevance,
  morphology,
} from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";
import {
  loadSoftwareLandJson,
  loadSoftwareLandRelevanceInputs,
} from "./helpers/software-land-fixture.js";
import { enforcedV1HistoricalTopNRows } from "./helpers/v1-historical-topn-contract.js";

const SCHEMA = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};
const SEED = 0x60d6e7ed;
const volumeTest = process.env.RUN_RANKING_EVIDENCE_VOLUME === "1" ? test : test.skip;

function publicRows(rows) {
  return (rows || []).map((row) => ({
    id: row.id,
    title: row.title,
    rank: row.rank,
    score: row.score,
    relevanceKind: row.relevanceKind,
    directClass: row.directClass,
    relationship: row.relationship || null,
  }));
}

function compareSearch(engine, query, options = {}) {
  const packed = engine.search(query, options);
  const packedMeta = { ...engine.lastSearchMeta };
  const detailed = engine.searchDetailed(query, options);
  const packedRelated = publicRows(packedMeta.related);
  const detailedRelated = publicRows(detailed.related);
  if (JSON.stringify(publicRows(packed)) !== JSON.stringify(publicRows(detailed.results))) {
    throw new Error(
      `result mismatch for ${JSON.stringify(query)} packed=${JSON.stringify(
        publicRows(packed)
      )} detailed=${JSON.stringify(publicRows(detailed.results))}`
    );
  }
  if (JSON.stringify(packedRelated) !== JSON.stringify(detailedRelated)) {
    throw new Error(`related mismatch for ${JSON.stringify(query)}`);
  }
  return packedMeta;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function mixedCorpus(n) {
  const specials = [
    { id: "network", title: "Network Guide", body: "network protocol notes search index document" },
    { id: "search-index", title: "Search Index Guide", body: "search index search index", lexicalFrequency: { "search index": 2 } },
    { id: "searching", title: "Searching Documents", body: "searching the index" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security handshake certificate pinning" },
    { id: "integrity", title: "Integrity Is Not Obedience", body: "integrity is a property of systems and people" },
  ];
  const rest = Math.max(0, n - specials.length);
  const settingsN = Math.floor(rest * 0.3);
  return [
    ...specials,
    ...generateSettings(settingsN, SEED ^ 0x11),
    ...generateArticle(rest - settingsN, { bodyTokens: 40, seed: SEED ^ 0x22, diverse: false }),
  ];
}

function dropChar(word, rng) {
  if (word.length < 4) return word.slice(0, -1) || word;
  const at = 1 + Math.floor(rng() * (word.length - 2));
  return word.slice(0, at) + word.slice(at + 1);
}

function codeToken(index) {
  let value = index;
  let suffix = "";
  for (let i = 0; i < 3; i++) {
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return `q${suffix}`;
}

function generatedQueries(documents, count, seed) {
  const rng = mulberry32(seed);
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const query = String(raw || "").trim().toLowerCase();
    if (query.length < 2 || seen.has(query)) return;
    seen.add(query);
    out.push(query);
  };
  for (const query of ["network", "search index", "searching", "searc", "serach", "tls", "integ"]) {
    push(query);
  }
  const titles = documents.map((document) => String(document.title || "")).filter(Boolean);
  for (const title of titles) {
    if (out.length >= count) break;
    const tokens = title
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((token) => token.length >= 2);
    if (!tokens.length) continue;
    push(tokens[0]);
    if (tokens.length >= 2) push(`${tokens[0]} ${tokens[1]}`);
    if (tokens[0].length >= 4) push(tokens[0].slice(0, 4));
    if (tokens[0].length >= 5) push(tokens[0].slice(0, 5));
  }
  let guard = 0;
  while (out.length < count && guard < count * 100) {
    guard += 1;
    const title = titles[Math.floor(rng() * titles.length)] || "";
    const tokens = title
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((token) => token.length >= 2);
    if (!tokens.length) continue;
    const mode = rng();
    if (mode < 0.3) push(tokens[0]);
    else if (mode < 0.55 && tokens.length >= 2) push(`${tokens[0]} ${tokens[1]}`);
    else if (mode < 0.78) {
      push(
        tokens[0].slice(
          0,
          Math.max(2, Math.min(tokens[0].length, 2 + Math.floor(rng() * 6)))
        )
      );
    } else {
      push(dropChar(tokens[0], rng));
    }
  }
  let fallback = 0;
  while (out.length < count) push(codeToken(fallback++));
  return out.slice(0, count);
}

describe("PROD-2 packed search() public differentials", () => {
  test("Software.Land historical/v1/v2/regression inventory matches searchDetailed", async () => {
    const {
      documents,
      configuredConcepts,
      lemmas,
      relationshipMap,
      relationships,
      lexicalFrequency,
      historical,
      schema,
    } = loadSoftwareLandRelevanceInputs();
    const authored = compileAuthoredRelevance({ configuredConcepts, relationshipMap });
    const plugins = [morphology({ lemmas }), ...authored.plugins];
    const indexedDocuments = attachLexicalFrequency(documents, lexicalFrequency);
    const lexicalIndex = compileLexicalIndex(indexedDocuments, { schema, plugins });
    const engine = SearchEngine.create({
      schema,
      plugins,
      lexicalIndex,
      documentRelationships: relationships,
      relationshipStrategy: "hybrid",
      retriever: "indexed",
    });
    await engine.index(indexedDocuments);

    const queries = [
      ...new Set(
        [
          ...historical.rows,
          ...enforcedV1HistoricalTopNRows(historical.rows),
          ...(loadSoftwareLandJson("v2-contracts.json").cases || []),
          ...(loadSoftwareLandJson("v2-contracts.json").overlayCases || []),
          ...(loadSoftwareLandJson("regression-scenarios.json").cases || []),
          ...(loadSoftwareLandJson("regression-scenarios.json").overlayCases || []),
        ]
          .map((row) => row.query)
          .filter(Boolean)
      ),
    ];
    expect(queries.length).toBe(189);

    let packed = 0;
    let fallback = 0;
    let mismatches = 0;
    const integ = compareSearch(engine, "integ", { limit: 10, relatedLimit: 5 });
    expect(engine.search("integ", { limit: 1 })[0].title).toBe("Integrity Is Not Obedience");
    expect(integ.rankingEvidence).toBe("packed");

    for (const query of queries) {
      const meta = compareSearch(engine, query, { limit: 10, relatedLimit: 5 });
      if (meta.rankingEvidence === "packed") packed += 1;
      else fallback += 1;
    }
    for (const relationshipStrategy of ["hybrid", "none", "mixed", "separate"]) {
      compareSearch(engine, "network", { limit: 8, relatedLimit: 4, relationshipStrategy });
      compareSearch(engine, "integ", { limit: 8, relatedLimit: 4, relationshipStrategy });
    }
    const asyncRows = await engine.searchAsync("integ", { limit: 8, relatedLimit: 3 });
    const syncRows = engine.search("integ", { limit: 8, relatedLimit: 3 });
    expect(publicRows(asyncRows)).toEqual(publicRows(syncRows));

    expect(mismatches).toBe(0);
    expect(packed + fallback).toBe(189);

    const adversarial = generatedQueries(indexedDocuments, 200, SEED ^ 0x51);
    expect(adversarial).toHaveLength(200);
    let generatedPacked = 0;
    let generatedFallback = 0;
    for (const query of adversarial) {
      const meta = compareSearch(engine, query, { limit: 10, relatedLimit: 5 });
      if (meta.rankingEvidence === "packed") generatedPacked += 1;
      else generatedFallback += 1;
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      packedSearchSoftwareLand: { queries: 189, packed, fallback, mismatches: 0 },
      packedSearchSoftwareLandGenerated: {
        queries: 200,
        packed: generatedPacked,
        fallback: generatedFallback,
        mismatches: 0,
      },
    }));
  }, 180_000);

  volumeTest("1000 generated 25k queries match searchDetailed", async () => {
    const documents = mixedCorpus(25_000);
    const plugins = [
      morphology(),
      compileConfiguredConceptPlugin({
        configuredConcepts: [
          { key: "tls", aliases: [["transport", "layer", "security"]] },
          { key: "ide", aliases: [["integrated", "development", "environment"]] },
        ],
      }),
    ];
    const lexicalIndex = compileLexicalIndex(documents, { schema: SCHEMA, plugins });
    const engine = SearchEngine.create({
      schema: SCHEMA,
      plugins,
      lexicalIndex,
      retriever: "indexed",
      relationshipStrategy: "hybrid",
    });
    await engine.index(documents);
    const queries = generatedQueries(documents, 1_000, SEED ^ 0xabc);
    expect(queries).toHaveLength(1_000);
    let packed = 0;
    let fallback = 0;
    let directFeatureVectors = 0;
    for (const query of queries) {
      const meta = compareSearch(engine, query, { limit: 10, relatedLimit: 5 });
      if (meta.rankingEvidence === "packed") {
        packed += 1;
        directFeatureVectors += Number(meta.directFeatureVectorsConstructed) || 0;
      } else fallback += 1;
    }
    expect(engine.search("integ", { limit: 1 })[0].id).toBe("integrity");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ packedSearchGenerated25k: { queries: 1000, packed, fallback, directFeatureVectors } }));
  }, 900_000);

  volumeTest("500 generated 100k queries match searchDetailed", async () => {
    const documents = mixedCorpus(100_000);
    const plugins = [
      morphology(),
      compileConfiguredConceptPlugin({
        configuredConcepts: [
          { key: "tls", aliases: [["transport", "layer", "security"]] },
          { key: "ide", aliases: [["integrated", "development", "environment"]] },
        ],
      }),
    ];
    const lexicalIndex = compileLexicalIndex(documents, { schema: SCHEMA, plugins });
    const engine = SearchEngine.create({
      schema: SCHEMA,
      plugins,
      lexicalIndex,
      retriever: "indexed",
      relationshipStrategy: "hybrid",
    });
    await engine.index(documents);
    const queries = generatedQueries(documents, 500, SEED ^ 0xdef);
    expect(queries).toHaveLength(500);
    let packed = 0;
    let fallback = 0;
    for (const query of queries) {
      const meta = compareSearch(engine, query, { limit: 10, relatedLimit: 5 });
      if (meta.rankingEvidence === "packed") packed += 1;
      else fallback += 1;
    }
    expect(engine.search("integ", { limit: 1 })[0].id).toBe("integrity");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ packedSearchGenerated100k: { queries: 500, packed, fallback } }));
  }, 1_800_000);
});
