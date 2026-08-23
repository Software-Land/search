import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SearchEngine, dictionary, morphology } from "../dist/index.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import {
  auditCompiledPostingWork,
  postingAuditSummary,
  POSTING_AUDIT_BLOCK_SIZE,
} from "../dist/exactPostingAudit.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "software-land");
const load = (name) =>
  JSON.parse(fs.readFileSync(path.join(fixture, name), "utf8"));

function publicSurface(value) {
  return {
    results: value.results,
    related: value.related,
  };
}

function ids(hits) {
  return hits.map((hit) => hit.document.id).sort();
}

async function compiledEngine(documents, extra = {}) {
  const plugins = extra.plugins || [];
  const lexicalIndex = extra.lexicalIndex || compileLexicalIndex(documents, {
    schema,
    plugins,
  });
  const engine = SearchEngine.create({
    schema,
    plugins,
    retriever: "indexed",
    relationshipStrategy: extra.relationshipStrategy ?? "none",
    relationships: extra.relationships || null,
    retrievalScoreWeight: extra.retrievalScoreWeight,
    lexicalIndex,
  });
  await engine.index(documents);
  return engine;
}

function hitSet(engine, query, skipDuplicatePostingLists) {
  const analyzed = engine._prepareQuery(query);
  return engine.retriever
    .retrieve(analyzed, engine._index, { skipDuplicatePostingLists })
    .map((hit) => [hit.document.id, ...(hit.retrievalSources || [])].join("\t"))
    .sort();
}

describe("Stage-2B exact posting-work audit", () => {
  test("shadow planner matches exhaustive visits and proves identical-list skip", async () => {
    const documents = [
      { id: "winner", title: "The", body: "" },
      ...Array.from({ length: 400 }, (_, i) => ({
        id: `body-${String(i).padStart(5, "0")}`,
        title: `Article ${i}`,
        body: "the common body",
      })),
    ];
    const engine = await compiledEngine(documents);
    const query = engine._prepareQuery("the");
    const exhaustive = engine.retriever.retrieve(query, engine._index, {
      skipDuplicatePostingLists: false,
    });
    const exhaustiveStats = engine.retriever.stats();
    const audit = auditCompiledPostingWork(
      query,
      engine._index.compiledLexical,
      engine._index.documents,
      "the"
    );
    expect(audit.plan.postingEntriesVisited).toBe(exhaustiveStats.postingEntriesVisited);
    expect(ids(exhaustive)).toEqual(
      audit.exactMatchOrdinals.map((pos) => engine._index.documents[pos].id).sort()
    );
    expect(audit.identicalListSkipMatchOrdinals).toEqual(audit.exactMatchOrdinals);
    expect(audit.plan.identicalListRewalkEntries).toBeGreaterThan(0);

    const pruned = engine.retriever.retrieve(query, engine._index, {
      skipDuplicatePostingLists: true,
    });
    const prunedStats = engine.retriever.stats();
    expect(ids(pruned)).toEqual(ids(exhaustive));
    expect(prunedStats.postingEntriesSkipped).toBe(audit.plan.identicalListRewalkEntries);
    expect(prunedStats.postingEntriesVisited).toBe(
      exhaustiveStats.postingEntriesVisited - audit.plan.identicalListRewalkEntries
    );
  });

  test("engine search skips duplicate posting lists only when retrievalScoreWeight is 0", async () => {
    const documents = Array.from({ length: 200 }, (_, i) => ({
      id: `doc-${String(i).padStart(5, "0")}`,
      title: `Article ${i}`,
      body: "the common body",
    }));
    const zero = await compiledEngine(documents);
    zero.search("the", { limit: 5, relatedLimit: 0 });
    expect(zero.lastSearchMeta.postingEntriesSkipped).toBeGreaterThan(0);
    expect(zero.lastSearchMeta.duplicatePostingEntriesAvoided).toBe(
      zero.lastSearchMeta.postingEntriesSkipped
    );
    const diagnostic = zero.searchDetailed("the", { limit: 5, relatedLimit: 0 });
    expect(diagnostic.meta.postingEntriesSkipped).toBe(0);

    const weighted = await compiledEngine(documents, { retrievalScoreWeight: 0.2 });
    weighted.search("the", { limit: 5, relatedLimit: 0 });
    expect(weighted.lastSearchMeta.postingEntriesSkipped).toBe(0);
    expect(weighted.lastSearchMeta.pruningFallbackReason).toBe("retrieval-score-weight");
  });

  test("distributed multi-term evidence cannot be dropped by a local posting-list skip", async () => {
    const documents = [
      { id: "aaa-alpha-only", title: "Alpha notes", body: "unrelated" },
      { id: "mmm-combined", title: "Alpha beta bridge", body: "together" },
      { id: "zzz-beta-only", title: "Beta notes", body: "unrelated" },
    ];
    const engine = await compiledEngine(documents);
    const query = engine._prepareQuery("alpha beta");
    const audit = auditCompiledPostingWork(
      query,
      engine._index.compiledLexical,
      engine._index.documents,
      "alpha beta"
    );
    const summary = postingAuditSummary(audit);
    expect(summary.identicalListSkipExact).toBe(true);
    const combined = audit.exactMatchOrdinals
      .map((pos) => engine._index.documents[pos].id)
      .includes("mmm-combined");
    expect(combined).toBe(true);
    expect(engine.search("alpha beta", { limit: 10, relatedLimit: 0 }).some((row) => row.id === "mmm-combined")).toBe(true);
    const alphaLane = audit.plan.lanes.filter((lane) => lane.term === "alpha" && lane.field === "title");
    const betaLane = audit.plan.lanes.filter((lane) => lane.term === "beta" && lane.field === "title");
    expect(alphaLane.some((lane) => lane.firstDiscoveryDocs > 0)).toBe(true);
    expect(betaLane.some((lane) => lane.firstDiscoveryDocs > 0)).toBe(true);
  });

  test("prefix-only documents remain after identical-list skip", async () => {
    const documents = [
      { id: "learning", title: "Machine Learning", body: "applied notes" },
      { id: "lemon", title: "Machine Lemon", body: "citrus" },
      { id: "unrelated", title: "Other notes", body: "the common body" },
    ];
    const engine = await compiledEngine(documents);
    for (const queryText of ["machine l", "machine le", "mach"]) {
      expect(hitSet(engine, queryText, true)).toEqual(hitSet(engine, queryText, false));
      const query = engine._prepareQuery(queryText);
      const audit = auditCompiledPostingWork(
        query,
        engine._index.compiledLexical,
        engine._index.documents,
        queryText
      );
      expect(audit.identicalListSkipMatchOrdinals).toEqual(audit.exactMatchOrdinals);
      if (queryText === "mach") {
        expect(audit.plan.prefixTermsExpanded).toBeGreaterThan(0);
      }
      const titles = engine.search(queryText, { limit: 10, relatedLimit: 0 }).map((row) => row.id);
      expect(titles).toContain("learning");
    }
  });

  test("unseen title signatures are not skippable from body posting saturation", async () => {
    const documents = [
      ...Array.from({ length: 300 }, (_, i) => ({
        id: `a-body-${String(i).padStart(5, "0")}`,
        title: `Article ${i}`,
        body: "open",
      })),
      { id: "z-title", title: "Open", body: "" },
    ];
    const engine = await compiledEngine(documents);
    expect(hitSet(engine, "open", true)).toEqual(hitSet(engine, "open", false));
    const actual = engine.search("open", { limit: 1, relatedLimit: 0 });
    expect(actual[0].id).toBe("z-title");
  });

  test("Software.Land 215 membership is unchanged by duplicate-list skip", async () => {
    const documents = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
    const engine = await compiledEngine(documents, {
      plugins: [
        morphology({ lemmas: load("lemmas.json") }),
        dictionary({ entries: load("dictionary.json") }),
      ],
      relationships: load("relationships.json"),
      relationshipStrategy: "hybrid",
    });
    for (const row of load("query-result-oracle.json").rows) {
      expect(hitSet(engine, row.query, true)).toEqual(hitSet(engine, row.query, false));
    }
  }, 120_000);

  test("expanded Software.Land +400 and randomized 1k stay exact", async () => {
    const originals = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
    const expanded = [
      ...originals,
      ...Array.from({ length: 400 }, (_, i) => ({
        id: `stage2b-sl-flood-${String(i).padStart(5, "0")}`,
        title: "Unrelated filler notes",
        body: "2 2 2 testing search the of and machine learning",
      })),
    ];
    const sl = await compiledEngine(expanded, {
      plugins: [
        morphology({ lemmas: load("lemmas.json") }),
        dictionary({ entries: load("dictionary.json") }),
      ],
    });
    for (const query of ["2", "the", "machine l", "tls"]) {
      expect(hitSet(sl, query, true)).toEqual(hitSet(sl, query, false));
    }

    let state = 0x51a9f00d;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const random = Array.from({ length: 1000 }, (_, i) => {
      const value = next();
      const token = value % 3 === 0 ? "open" : value % 3 === 1 ? "search" : "the";
      return {
        id: `random-${String(i).padStart(7, "0")}`,
        title: value % 97 === 0 ? `${token} Exact ${i}` : `Article ${i}`,
        body: `${token} common body`,
      };
    });
    const randomized = await compiledEngine(random);
    for (const query of ["the", "open", "search"]) {
      expect(hitSet(randomized, query, true)).toEqual(hitSet(randomized, query, false));
      const full = SearchEngine.create({ schema, retriever: "full-scan", relationshipStrategy: "none" });
      await full.index(random);
      expect(publicSurface(randomized.searchDetailed(query, { limit: 10, relatedLimit: 0 }))).toEqual(
        publicSurface(full.searchDetailed(query, { limit: 10, relatedLimit: 0 }))
      );
    }
  }, 120_000);

  test("audit block size stays aligned with Stage 2A", () => {
    expect(POSTING_AUDIT_BLOCK_SIZE).toBe(128);
  });
});
