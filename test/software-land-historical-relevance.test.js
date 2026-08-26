/**
 * Software.Land historical expectedTop / titlePrefix relevance contracts.
 * Fixture-only. Not Core default ranking policy.
 * Separate from query-result-oracle.json exact-output identity.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology, dictionary, synonyms } from "../dist/index.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import {
  evaluateHistoricalRelevance,
  formatHistoricalRelevanceFailure,
  isHistoricalRelevanceApplicable,
} from "./historical-relevance.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

const documents = loadJson("documents.json");
const historical = loadJson("historical-scenarios.json");
const relevanceConfig = loadJson("relevance-config.json");
const synonymFixture = loadJson("synonym-map.json");
const omitKeys = new Set(relevanceConfig.omitDictionaryKeys || []);

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
    return {
      ...entry,
      aliases,
      topicalRecall: Array.isArray(patch.topicalRecall) ? patch.topicalRecall.map((form) => [...form]) : entry.topicalRecall,
    };
  });
}

const dictionaryEntries = applyDictionaryPatches(
  loadJson("dictionary.json").filter((entry) => !omitKeys.has(entry.key)),
  relevanceConfig.dictionaryPatches
);

const applicable = historical.rows.filter(isHistoricalRelevanceApplicable);
const recorded = [];
const APPSEC_TOPICAL = [
  ["authentication"],
  ["authorization"],
  ["rbac"],
  ["saml"],
  ["oauth"],
  ["bearer", "token"],
  ["vulnerability"],
  ["signed", "cookies"],
];

function createRelevanceEngine() {
  return SearchEngine.create({
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
    plugins: [
      morphology({ lemmas: loadJson("lemmas.json") }),
      dictionary({ entries: dictionaryEntries }),
      synonyms(synonymFixture.map),
    ],
    relationships: loadJson("relationships.json"),
    relationshipStrategy: "hybrid",
    retriever: "full-scan",
  });
}

describe("Software.Land historical relevance contracts", () => {
  let engine;

  beforeAll(async () => {
    engine = createRelevanceEngine();
    await engine.index(attachLexicalFrequency(documents, loadJson("lexical-frequency.json")));
  });

  afterAll(() => {
    const failed = recorded.filter((row) => !row.ok);
    const uniqueFailing = [...new Set(failed.map((row) => row.query))];
    const kinds = {};
    for (const row of failed) {
      for (const kind of row.kinds.length ? row.kinds : ["unclassified"]) {
        kinds[kind] = (kinds[kind] || 0) + 1;
      }
    }
    // Compact aggregate. Individual test.each failures remain the source of truth.
    console.log(
      [
        "historical relevance:",
        `  ${recorded.filter((row) => row.ok).length} / ${recorded.length} pass`,
        `  ${failed.length} fail`,
        `  ${uniqueFailing.length} unique failing queries`,
        `  kinds ${JSON.stringify(kinds)}`,
      ].join("\n")
    );
  });

  test("quality ass membership-within-topN does not require expectedTop array order", () => {
    const row = historical.rows.find((item) => item.query === "quality ass");
    expect(row.v1).toEqual({
      expectedTop: ["Load vs Stress Testing", "Testing in Software Engineering"],
      topN: 2,
    });
    expect(
      evaluateHistoricalRelevance(row, [
        "Testing in Software Engineering",
        "Load vs Stress Testing",
      ]).ok
    ).toBe(true);
  });

  test("query 12 historical contract is TLS 1.2 Vulnerability #1", () => {
    const row = historical.rows.find((item) => item.query === "12");
    expect(row.historicalRelevance).toBe(true);
    expect(row.v1).toEqual({
      expectedTop: ["TLS 1.2 Vulnerability"],
      topN: 1,
    });
    expect(row.intent.requiredPrimary).toEqual(["TLS 1.2 Vulnerability"]);
    expect(evaluateHistoricalRelevance(row, ["TLS 1.2 Vulnerability"]).ok).toBe(true);
    expect(
      evaluateHistoricalRelevance(row, [
        "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
        "TLS 1.2 Vulnerability",
      ]).ok
    ).toBe(false);
  });

  test("appsec uses topicalRecall for neighbors and only oath as synonym recall", () => {
    const detailed = engine.searchDetailed("appsec", { limit: documents.length, explain: true });
    const q = detailed.results[0]?.explanation?.query;
    expect(detailed.results[0]?.title).toBe("App Sec");
    expect(q?.configuredSequenceIntent?.key).toBe("appsec");
    expect(q?.synonymRecall).toEqual([{ source: "appsec", target: "oath" }]);
    expect(q?.topicalRecall).toEqual({ key: "appsec", forms: APPSEC_TOPICAL });
  });

  test("what is an app sec activates wrapped exact topicalRecall", () => {
    const detailed = engine.searchDetailed("what is an app sec", { limit: 10, explain: true });
    const q = detailed.results[0]?.explanation?.query;
    expect(detailed.results[0]?.title).toBe("App Sec");
    expect(q?.configuredSequenceIntent ?? null).toBeNull();
    expect(q?.topicalRecall).toEqual({ key: "appsec", forms: APPSEC_TOPICAL });
  });

  test("what is an applicatio security stays bounded prefix without topicalRecall", () => {
    const detailed = engine.searchDetailed("what is an applicatio security", { limit: 10, explain: true });
    const q = detailed.results[0]?.explanation?.query;
    expect(detailed.results[0]?.title).toBe("App Sec");
    expect(q?.configuredSequenceIntent ?? null).toBeNull();
    expect(q?.configuredPrefixSpans).toEqual([expect.objectContaining({ key: "appsec", usedPrefix: true })]);
    expect(q?.topicalRecall ?? null).toBeNull();
    expect(detailed.results.every((hit) => !(hit.retrievalSources || []).includes("topical-recall"))).toBe(true);
  });

  test("fixture models current Software.Land 0.5 curated synonym and AppSec topical configuration", () => {
    expect(relevanceConfig.softwareLandCommit).toBe("7628a85166781d4ab42f60646e2f66da5f336eaa");
    expect(relevanceConfig.synonymMapKind).toBe("explicit-directional-curated-plus-generated");
    expect(omitKeys.has("testing")).toBe(true);
    expect(dictionaryEntries.some((entry) => entry.key === "testing")).toBe(false);
    expect(loadJson("dictionary.json").some((entry) => entry.key === "testing")).toBe(true);
    const frozenAppsec = loadJson("dictionary.json").find((entry) => entry.key === "appsec");
    expect(frozenAppsec.aliases).toEqual(expect.arrayContaining([["security"]]));
    expect(frozenAppsec.topicalRecall).toBeUndefined();
    const frozenNist = loadJson("dictionary.json").find((entry) => entry.key === "nist");
    expect(frozenNist.aliases).toEqual([]);
    const nist = dictionaryEntries.find((entry) => entry.key === "nist");
    expect(nist.aliases).toEqual([["institute"], ["institute", "standards"]]);
    const gatech = dictionaryEntries.find((entry) => entry.key === "gatech");
    expect(gatech.aliases).toEqual([]);
    const appsec = dictionaryEntries.find((entry) => entry.key === "appsec");
    expect(appsec.aliases).toEqual([
      ["app", "sec"],
      ["app", "security"],
      ["application", "sec"],
    ]);
    expect(appsec.topicalRecall).toEqual(APPSEC_TOPICAL);
    expect(synonymFixture.softwareLandCommit).toBe("db5a070dbc6ac112dfae403f38fdfd0fffbedbf6");
    expect(synonymFixture.stats).toEqual({ sources: 119, edges: 146, jsonBytes: 3081 });
    expect(synonymFixture.map.qa).toEqual(["testing"]);
    expect(synonymFixture.map.testing).toBeUndefined();
    expect(synonymFixture.map.appsec).toEqual(["oath"]);
    expect(synonymFixture.map["i o"]).toEqual(["io"]);
    expect(synonymFixture.map["tech debt"]).toBeUndefined();
    expect(synonymFixture.map["ai assisted coding"]).toBeUndefined();
    expect(synonymFixture.map.vpn).toEqual(["tls"]);
    expect(synonymFixture.map.tls).toEqual(["ssl"]);
    expect(synonymFixture.map.tls).not.toEqual(expect.arrayContaining(["vpn"]));
    expect(synonymFixture.map.authentication).toEqual(expect.arrayContaining(["vulnerability"]));
    expect(synonymFixture.map.vulnerability).toEqual(expect.arrayContaining(["authentication"]));
    expect(synonymFixture.map.bearer).toEqual(["token"]);
    expect(synonymFixture.map.token).toBeUndefined();
    expect(synonymFixture.map.rbac).toBeUndefined();
    expect(synonymFixture.map.architecture).toBeUndefined();
    expect(historical.counts.historicalRelevanceApplicable).toBe(214);
    expect(applicable).toHaveLength(214);
    expect(applicable.filter((row) => row.classification === "C")).toHaveLength(0);
    expect(historical.rows.filter((row) => row.classification === "C").map((row) => row.query)).toEqual(["sharde"]);
    expect(applicable.filter((row) => row.v1?.titlePrefix)).toHaveLength(1);
  });

  test.each(applicable.map((row) => [row.index, row.query, row]))(
    "row %s query %s historical relevance",
    (_index, _query, row) => {
      const titles = engine.search(row.query, { limit: documents.length }).map((hit) => hit.title);
      const evaluation = evaluateHistoricalRelevance(row, titles);
      recorded.push(evaluation);
      if (!evaluation.ok) {
        throw new Error(formatHistoricalRelevanceFailure(evaluation));
      }
    }
  );
});
