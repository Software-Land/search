import {
  SearchEngine,
  compileAuthoredRelevance,
  morphology,
} from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { compileLexicalIndex } from "../dist/indexing/lexicalIndex.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";
import { RankingEvidenceSessionPool } from "../dist/ranking/evidence/rankingEvidenceState.js";
import { loadSoftwareLandRelevanceInputs } from "./helpers/software-land-fixture.js";
import {
  releaseEvidence,
  runEvidence,
} from "./helpers/ranking-evidence-prod1.js";

const SCHEMA = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};
const SEED = 0x60d6e7ed;
const volumeTest = process.env.RUN_RANKING_EVIDENCE_VOLUME === "1" ? test : test.skip;

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

function codeToken(index) {
  let value = index;
  let suffix = "";
  for (let i = 0; i < 3; i++) {
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return `q${suffix}`;
}

function validationDocuments(count) {
  const categories = [
    "raaa",
    "raab",
    "raac",
    "raad",
    "raae",
    "raaf",
    "raag",
    "raah",
  ];
  return Array.from({ length: count }, (_, index) => {
    const code = codeToken(index);
    const category = categories[index % categories.length];
    const validationQuery = `${code} ${category}`;
    return {
      id: `validation-${code}`,
      title: `${code} entry`,
      body: `${validationQuery} evidence`,
      lexicalFrequency: { [validationQuery]: 1 },
      validationQuery,
    };
  });
}

function mixedCorpus(n) {
  const specials = [
    {
      id: "rare-exact",
      title: "ZX9 UniqueRareTitle",
      body: "unique rare title planted for exact retrieval",
    },
    {
      id: "tls",
      title: "TLS Guide",
      body: "transport layer security handshake certificate pinning",
      lexicalFrequency: { tls: 1, "transport layer": 1 },
    },
    {
      id: "search-index",
      title: "Search Index Guide",
      body: "search index search index",
      lexicalFrequency: { "search index": 2 },
    },
    {
      id: "search-index-prefix",
      title: "Searching Indexes",
      body: "searching indexes",
      lexicalFrequency: null,
    },
    {
      id: "integrity",
      title: "Integrity Is Not Obedience",
      body: "integrity is a property of systems and people",
    },
  ];
  const validation = validationDocuments(Math.min(1_200, Math.max(0, n - specials.length)));
  const rest = Math.max(0, n - specials.length - validation.length);
  const settingsN = Math.floor(rest * 0.3);
  return [
    ...specials,
    ...generateSettings(settingsN, SEED ^ 0x11),
    ...generateArticle(rest - settingsN, {
      bodyTokens: 40,
      seed: SEED ^ 0x22,
      diverse: false,
    }),
    ...validation,
  ];
}

function dropChar(word, rng) {
  if (word.length < 4) return word.slice(0, -1) || word;
  const at = 1 + Math.floor(rng() * (word.length - 2));
  return word.slice(0, at) + word.slice(at + 1);
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
  for (const query of [
    "network",
    "search index",
    "searching",
    "searc",
    "serach",
    "tls",
    "integ",
    "zx9 uniqueraretitle",
    "wifi settings",
    "bluetooth",
    "document query",
    "title prefix",
  ]) {
    push(query);
  }
  const ordinaryDocuments = documents.filter((document) => !document.validationQuery);
  const titles = ordinaryDocuments
    .map((document) => String(document.title || ""))
    .filter(Boolean);
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
  for (const document of documents) {
    if (out.length >= count) break;
    if (document.validationQuery) push(document.validationQuery);
  }
  let fallback = 0;
  while (out.length < count) {
    push(codeToken(fallback++));
  }
  return out.slice(0, count);
}

function emptyTotal(label, corpus, requested) {
  return {
    label,
    corpus,
    requested,
    queries: 0,
    eligible: 0,
    ineligible: 0,
    eligibilityPct: 0,
    candidates: 0,
    primitiveMismatches: 0,
    scoreMismatches: 0,
    reasons: {},
    bodyScanCalls: 0,
    bodyTokenCells: 0,
    bodyScanMs: 0,
  };
}

function runAudit(engine, queries, label, corpus) {
  const pool = new RankingEvidenceSessionPool();
  const total = emptyTotal(label, corpus, queries.length);
  for (const rawQuery of queries) {
    const run = runEvidence(engine, rawQuery, { pool });
    try {
      total.queries += 1;
      if (!run.eligible) {
        total.ineligible += 1;
        total.reasons[run.reason] = (total.reasons[run.reason] || 0) + 1;
        continue;
      }
      total.eligible += 1;
      total.candidates += run.diff.candidates;
      total.primitiveMismatches += run.diff.primitiveMismatches;
      total.scoreMismatches += run.diff.scoreMismatches;
      total.bodyScanCalls += run.finalized.counters.bodyScanCalls;
      total.bodyTokenCells += run.finalized.counters.bodyTokenCells;
      total.bodyScanMs += run.finalized.counters.bodyScanMs;
      if (run.diff.samples.length) {
        throw new Error(
          `${label} ${JSON.stringify(rawQuery)} evidence mismatch: ${JSON.stringify(
            run.diff.samples
          )}`
        );
      }
    } finally {
      releaseEvidence(run);
    }
  }
  total.eligibilityPct = Number(
    ((100 * total.eligible) / Math.max(total.queries, 1)).toFixed(2)
  );
  total.bodyScanMs = Number(total.bodyScanMs.toFixed(3));
  total.retainedPool = pool.memory();
  return total;
}

async function generatedEngine(n) {
  const documents = mixedCorpus(n);
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
  return { engine, documents };
}

volumeTest("1000 generated 25k queries audit every eligible retrieved candidate", async () => {
  const { engine, documents } = await generatedEngine(25_000);
  const queries = generatedQueries(documents, 1_000, SEED ^ 0xabc);
  expect(queries).toHaveLength(1_000);
  const total = runAudit(engine, queries, "generated-25k", 25_000);
  expect(total.primitiveMismatches).toBe(0);
  expect(total.scoreMismatches).toBe(0);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rankingEvidenceRandomized: total }));
}, 900_000);

volumeTest("500 generated 100k queries audit every eligible retrieved candidate", async () => {
  const { engine, documents } = await generatedEngine(100_000);
  const queries = generatedQueries(documents, 500, SEED ^ 0xdef);
  expect(queries).toHaveLength(500);
  const total = runAudit(engine, queries, "generated-100k", 100_000);
  expect(total.primitiveMismatches).toBe(0);
  expect(total.scoreMismatches).toBe(0);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rankingEvidenceRandomized: total }));
}, 1_800_000);

volumeTest("200 generated Software.Land queries audit fused eligibility and exactness", async () => {
  const {
    documents,
    configuredConcepts,
    lemmas,
    relationshipMap,
    relationships,
    lexicalFrequency,
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
  const queries = generatedQueries(documents, 200, SEED ^ 0x123);
  expect(queries).toHaveLength(200);
  const total = runAudit(engine, queries, "generated-software-land", documents.length);
  expect(total.primitiveMismatches).toBe(0);
  expect(total.scoreMismatches).toBe(0);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rankingEvidenceRandomized: total }));
}, 300_000);
