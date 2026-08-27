/**
 * Product-stack indexed/full-scan equality on the Software.Land fixture.
 * compileAuthoredRelevance + relationships. Not Core default ranking policy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { createIndexedLexicalRetriever } from "../dist/retrievers.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { isHistoricalRelevanceApplicable } from "./historical-relevance.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

function aliasKey(alias) {
  return JSON.stringify(Array.isArray(alias) ? alias : []);
}

function applyDictionaryPatches(entries, patches) {
  return entries.map((entry) => {
    const patch = patches?.[entry.key];
    if (!patch) return entry;
    const omit = new Set((patch.omitAliases || []).map(aliasKey));
    const aliases = (entry.aliases || []).filter((alias) => !omit.has(aliasKey(alias)));
    const seen = new Set(aliases.map(aliasKey));
    for (const alias of patch.addAliases || []) {
      const form = Array.isArray(alias) ? alias : [];
      const key = aliasKey(form);
      if (!form.length || seen.has(key)) continue;
      seen.add(key);
      aliases.push([...form]);
    }
    return { ...entry, aliases };
  });
}

const relevanceConfig = loadJson("relevance-config.json");
const omitKeys = new Set(relevanceConfig.omitDictionaryKeys || []);
const dictionaryEntries = applyDictionaryPatches(
  loadJson("dictionary.json").filter((entry) => !omitKeys.has(entry.key)),
  relevanceConfig.dictionaryPatches
);
const documents = loadJson("documents.json");

function serialize(detailed, { features = false } = {}) {
  const row = {
    candidateCount: detailed.meta.candidateCount,
    ids: detailed.results.map((hit) => hit.id),
    scores: detailed.results.map((hit) => hit.score),
    relevanceKind: detailed.results.map((hit) => hit.relevanceKind),
    directClass: detailed.results.map((hit) => hit.directClass ?? null),
    relatedIds: (detailed.related || []).map((hit) => hit.id),
  };
  if (!features) return row;
  row.features = Object.fromEntries(
    detailed.results.map((hit) => [
      hit.id,
      JSON.parse(
        JSON.stringify(hit.features || {}, (key, value) => (key === "retrievalScore" ? undefined : value))
      ),
    ])
  );
  return row;
}

function divergence(full, indexed) {
  const n = Math.max(full.ids.length, indexed.ids.length);
  let first = null;
  for (let i = 0; i < n; i++) {
    if (
      full.ids[i] !== indexed.ids[i] ||
      full.scores[i] !== indexed.scores[i] ||
      full.relevanceKind[i] !== indexed.relevanceKind[i] ||
      full.directClass[i] !== indexed.directClass[i]
    ) {
      first = i + 1;
      break;
    }
  }
  const featureMismatches = [];
  if (full.features && indexed.features) {
    for (const id of full.ids.filter((docId) => indexed.ids.includes(docId))) {
      if (JSON.stringify(full.features[id]) !== JSON.stringify(indexed.features[id])) {
        featureMismatches.push(id);
      }
    }
  }
  const exact =
    first === null &&
    full.candidateCount === indexed.candidateCount &&
    JSON.stringify(full.relatedIds) === JSON.stringify(indexed.relatedIds) &&
    featureMismatches.length === 0;
  return { exact, first, featureMismatches };
}

function occupyingForms(dict) {
  const seen = new Set();
  const out = [];
  for (const entry of dict.entries) {
    for (const form of [[entry.key], entry.expansion, ...(entry.aliases || [])]) {
      if (!form?.length) continue;
      const q = form.join(" ");
      if (!q || seen.has(q)) continue;
      seen.add(q);
      out.push(q);
    }
  }
  return out;
}

describe("Software.Land product retrieval-mode parity", () => {
  let engines;
  let compiled;
  const family = [
    "ci",
    "continuous integration",
    "continuous i",
    "continuous int",
    "continuous integ",
    "cd",
    "continuous deployment",
    "continuous d",
    "continuous dep",
    "continuous deplo",
    "cicd",
    "ci cd",
    "ci/cd",
    "continuous integration continuous deployment",
    "sre",
    "site reliability engineering",
  ];
  const controls = [
    "interface",
    "build time",
    "paas",
    "platform as a service",
    "devops",
    "api",
    "application programming interface",
    "authn",
    "authz",
    "oauth",
    "author",
    "http",
    "hypertext",
    "shard",
    "recursion",
    "recurssing",
    "appsec",
    "institute",
    "a*",
    "io",
  ];

  beforeAll(async () => {
    compiled = compileAuthoredRelevance({
      entries: dictionaryEntries,
      relationshipMap: loadJson(relevanceConfig.relationshipMapFile).map,
    });
    const plugins = [
      morphology({ lemmas: loadJson("lemmas.json") }),
      ...compiled.plugins,
    ];
    const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
    const docs = attachLexicalFrequency(documents, loadJson("lexical-frequency.json"));
    const rel = loadJson("relationships.json");
    engines = {};
    for (const [name, retriever] of [
      ["full", "full-scan"],
      ["compiled", "indexed"],
      ["legacy", createIndexedLexicalRetriever({ candidateLimit: 200, prefixCap: 800 })],
    ]) {
      engines[name] = SearchEngine.create({
        schema,
        plugins,
        relationships: rel,
        relationshipStrategy: "hybrid",
        retriever,
      });
      await engines[name].index(docs);
    }
  }, 60000);

  function compareQueries(queries, limit, { features = false } = {}) {
    const rows = [];
    for (const q of queries) {
      const opts = { limit, relatedLimit: 8, explain: features };
      const full = serialize(engines.full.searchDetailed(q, opts), { features });
      const compiledView = serialize(engines.compiled.searchDetailed(q, opts), { features });
      const legacy = serialize(engines.legacy.searchDetailed(q, opts), { features });
      const compiledCmp = divergence(full, compiledView);
      const legacyCmp = divergence(full, legacy);
      if (!compiledCmp.exact || !legacyCmp.exact) {
        rows.push({
          q,
          compiled: compiledCmp,
          legacy: legacyCmp,
          fullIds: full.ids,
          compiledIds: compiledView.ids,
          legacyIds: legacy.ids,
          fullC: full.candidateCount,
          compiledC: compiledView.candidateCount,
          legacyC: legacy.candidateCount,
        });
      }
    }
    return rows;
  }

  test("CI/CICD/CD/SRE families match across full-scan, compiled, and legacy indexed", () => {
    expect(compareQueries(family, 20, { features: true })).toEqual([]);
    expect(compareQueries(family, documents.length, { features: true })).toEqual([]);
  });

  test("184 applicable historical queries match at top-10 and complete list", () => {
    const queries = [
      ...new Set(loadJson("historical-scenarios.json").rows.filter(isHistoricalRelevanceApplicable).map((row) => row.query)),
    ];
    expect(queries).toHaveLength(184);
    expect(compareQueries(queries, 10)).toEqual([]);
    expect(compareQueries(queries, documents.length)).toEqual([]);
  });

  test("every authored configured form matches across retrieval modes", () => {
    const queries = occupyingForms(compiled.plugins.find((plugin) => plugin.name === "dictionary"));
    expect(queries.length).toBeGreaterThan(300);
    expect(compareQueries(queries, 10)).toEqual([]);
    expect(compareQueries(queries, documents.length)).toEqual([]);
  });

  test("critical control queries stay mode-equivalent", () => {
    expect(compareQueries(controls, 10)).toEqual([]);
  });
});
