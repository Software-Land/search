/**
 * Indexed / compiled retrieval must discover the same recall-prefix evidence
 * as full-scan. Generic corpora only. Not Software.Land ranking policy.
 */
import {
  SearchEngine,
  morphology,
  compileAuthoredRelevance,
  DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD,
} from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { synonyms } from "../dist/query/synonyms.js";
import { createIndexedLexicalRetriever } from "../dist/retrievers.js";
import { retrievalFormKindAllowsPrefix } from "../dist/retrieve.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function ids(hits) {
  return hits.map((hit) => hit.id);
}

function publicHits(engine, query, limit = 50) {
  const detailed = engine.searchDetailed(query, { limit, relatedLimit: 0, explain: true });
  return {
    candidateCount: detailed.meta.candidateCount,
    ids: ids(detailed.results),
    scores: detailed.results.map((hit) => hit.score),
    relevanceKind: detailed.results.map((hit) => hit.relevanceKind),
    directClass: detailed.results.map((hit) => hit.directClass ?? null),
    sources: Object.fromEntries(
      detailed.results.map((hit) => [hit.id, [...(hit.retrievalSources || [])].sort()])
    ),
    features: Object.fromEntries(
      detailed.results.map((hit) => [
        hit.id,
        JSON.parse(
          JSON.stringify(hit.features || {}, (key, value) => (key === "retrievalScore" ? undefined : value))
        ),
      ])
    ),
  };
}

function expectModeParity(engines, query, limit = 50) {
  const views = Object.fromEntries(
    Object.entries(engines).map(([name, engine]) => [name, publicHits(engine, query, limit)])
  );
  const base = views.full;
  for (const [name, view] of Object.entries(views)) {
    expect({ name, ...view }).toEqual({ name, ...base });
  }
  return views;
}

async function makeEngine(retriever, { plugins, docs }) {
  const engine = SearchEngine.create({
    schema,
    plugins,
    retriever,
    relationshipStrategy: "none",
  });
  await engine.index(docs);
  return engine;
}

async function makeModeEngines({ plugins, docs }) {
  return {
    full: await makeEngine("full-scan", { plugins, docs }),
    compiled: await makeEngine("indexed", { plugins, docs }),
    legacy: await makeEngine(createIndexedLexicalRetriever({ candidateLimit: 200, prefixCap: 800 }), {
      plugins,
      docs,
    }),
  };
}

const ciPlugins = [
  morphology(),
  compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "ci", aliases: [["continuous", "integration"]] }] }),
  synonyms({ ci: ["devops"] }),
];

describe("retrieval form prefix policy", () => {
  test("equivalent-recall and ordinary kinds admit prefix; topical-recall does not", () => {
    expect(retrievalFormKindAllowsPrefix("equivalent-recall")).toBe(true);
    expect(retrievalFormKindAllowsPrefix("standalone-recall")).toBe(true);
    expect(retrievalFormKindAllowsPrefix("concept")).toBe(true);
    expect(retrievalFormKindAllowsPrefix("token")).toBe(true);
    expect(retrievalFormKindAllowsPrefix("topical-recall")).toBe(false);
    expect(retrievalFormKindAllowsPrefix("configured-prefix-recall")).toBe(false);
  });
});

describe("equivalent-recall prefix posting completeness", () => {
  const docs = [
    { id: "ci-canonical", title: "Continuous Integration", body: "pipeline notes" },
    { id: "syn-body-prefix", title: "Vendor Class", body: "devopsschool curriculum notes" },
    { id: "syn-title-prefix", title: "Devopsschool Guide", body: "gardening tips tomatoes" },
    { id: "unrelated", title: "Gardening Tips", body: "soil and tomatoes" },
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `noise-${i}`,
      title: `Noise ${i}`,
      body: "lorem ipsum dolor sit amet notes",
    })),
  ];
  let engines;

  beforeAll(async () => {
    engines = await makeModeEngines({ plugins: ciPlugins, docs });
  });

  test("ci and continuous integration retrieve the same prefix-only synonym hits in every mode", () => {
    const ciViews = expectModeParity(engines, "ci");
    expect(ciViews.full.ids).toEqual(expect.arrayContaining(["ci-canonical", "syn-body-prefix", "syn-title-prefix"]));
    expect(ciViews.full.ids).not.toContain("unrelated");
    expect(ciViews.full.sources["syn-body-prefix"]).toEqual(["equivalent-recall"]);
    expect(ciViews.full.sources["syn-title-prefix"]).toEqual(["equivalent-recall"]);
    const expansionViews = expectModeParity(engines, "continuous integration");
    expect(expansionViews.full.ids).toContain("ci-canonical");
    expect(expansionViews.full.ids).not.toContain("unrelated");
  });

  test("legacy indexed, compiled indexed, and full-scan agree on complete lists", () => {
    expectModeParity(engines, "ci", docs.length);
    expectModeParity(engines, "continuous integration", docs.length);
  });
});

describe("equivalent-recall prefix information bound", () => {
  test("1-character and 2-character recall forms do not gain prefix fanout", async () => {
    const docs = [
      { id: "short-1", title: "Notes", body: "developer handbook" },
      { id: "short-2", title: "Notes", body: "deployment handbook" },
    ];
    const plugins1 = [
      morphology(),
      compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "ci", aliases: [["continuous", "integration"]] }] }),
      synonyms({ ci: ["d"] }),
    ];
    const plugins2 = [
      morphology(),
      compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "ci", aliases: [["continuous", "integration"]] }] }),
      synonyms({ ci: ["de"] }),
    ];
    const one = await makeModeEngines({ plugins: plugins1, docs });
    const two = await makeModeEngines({ plugins: plugins2, docs });
    expectModeParity(one, "ci");
    expectModeParity(two, "ci");
    expect(publicHits(one.full, "ci").ids).not.toContain("short-1");
    expect(publicHits(two.full, "ci").ids).not.toContain("short-2");
  });

  test("3-character recall form admits body startsWith and title allowPrefixMatch only", async () => {
    const docs = [
      { id: "body-ok", title: "Notes", body: "developer handbook" },
      { id: "title-poor-ratio", title: "Developer Handbook", body: "gardening" },
      { id: "title-ok", title: "Deva Notes", body: "gardening" },
      { id: "unrelated", title: "Soil", body: "tomatoes" },
    ];
    const plugins = [
      morphology(),
      compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "ci", aliases: [["continuous", "integration"]] }] }),
      synonyms({ ci: ["dev"] }),
    ];
    const engines = await makeModeEngines({ plugins, docs });
    const views = expectModeParity(engines, "ci");
    expect(views.full.ids).toEqual(expect.arrayContaining(["body-ok", "title-ok"]));
    expect(views.full.ids).not.toContain("title-poor-ratio");
    expect(views.full.ids).not.toContain("unrelated");
  });

  test("unrelated vocabulary that does not prefix the recall form is not retrieved", async () => {
    const docs = [
      { id: "ci-canonical", title: "Continuous Integration", body: "pipeline" },
      { id: "development", title: "Development Notes", body: "development handbook" },
    ];
    const engines = await makeModeEngines({ plugins: ciPlugins, docs });
    const views = expectModeParity(engines, "ci");
    expect(views.full.ids).toContain("ci-canonical");
    expect(views.full.ids).not.toContain("development");
  });
});

describe("topical-recall remains exact-only", () => {
  const plugins = [
    morphology(),
    compileAuthoredRelevance({ configuredConcepts: [{ key: "appsec", aliases: [["application", "security"]] }],
      relationshipMap: { appsec: [{ to: { form: ["authentication"] }, kind: "related" }] },
    }).plugins.find((plugin) => plugin.name === "configured-concepts"),
  ];
  const docs = [
    { id: "direct", title: "Application Security", body: "overview" },
    { id: "exact-body", title: "Login Notes", body: "password authentication cookies" },
    { id: "exact-title", title: "Authentication Guide", body: "gardening" },
    { id: "prefix-body", title: "School Notes", body: "authenticationservice vendor class" },
    { id: "prefix-title", title: "Authenticationservice Guide", body: "gardening tomatoes" },
  ];
  let engines;

  beforeAll(async () => {
    engines = await makeModeEngines({ plugins, docs });
  });

  test("full-scan and indexed retrieve exact topical forms only", () => {
    const views = expectModeParity(engines, "application security");
    expect(views.full.ids).toEqual(expect.arrayContaining(["direct", "exact-body", "exact-title"]));
    expect(views.full.ids).not.toContain("prefix-body");
    expect(views.full.ids).not.toContain("prefix-title");
    expect(views.full.sources["exact-body"]).toEqual(["topical-recall"]);
    expect(views.full.sources["exact-title"]).toEqual(["topical-recall"]);
  });
});

describe("adaptive uses indexed above the default document threshold", () => {
  test("recall-prefix hits stay equivalent once adaptive selects indexed", async () => {
    const signal = [
      { id: "ci-canonical", title: "Continuous Integration", body: "pipeline notes" },
      { id: "syn-body-prefix", title: "Vendor Class", body: "devopsschool curriculum notes" },
    ];
    const pad = Array.from({ length: DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD - signal.length + 1 }, (_, i) => ({
      id: `pad-${i}`,
      title: `Pad ${i}`,
      body: "lorem unrelated",
    }));
    const docs = [...signal, ...pad];
    expect(docs.length).toBe(DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD + 1);
    const full = await makeEngine("full-scan", { plugins: ciPlugins, docs });
    const adaptive = await makeEngine("adaptive", { plugins: ciPlugins, docs });
    expect(adaptive.retriever.stats().active).toBe("indexed-lexical");
    expect(publicHits(adaptive, "ci")).toEqual(publicHits(full, "ci"));
    expect(publicHits(adaptive, "ci").ids).toContain("syn-body-prefix");
    expect(publicHits(adaptive, "continuous integration")).toEqual(publicHits(full, "continuous integration"));
    expect(publicHits(adaptive, "continuous integration").ids).toContain("ci-canonical");
  }, 60000);
});
