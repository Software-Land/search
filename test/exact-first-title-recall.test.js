/**
 * Exact-first group title keys use the same coverage-only score as unique
 * prefix recall. Independent of the Software.Land corpus.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { COMPLETE_INTERPRETATION_COLLECTOR } from "../dist/execution/completeInterpretationCollector.js";
import { compareConstraint, constraintsForStrategy } from "../dist/ranking/constraints.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const shortForm = ["lumen", "petal"];
const longForm = [
  "lumen",
  "sepal",
  "corolla",
  "stamen",
  "pistil",
  "nectar",
  "pollen",
  "anther",
  "ovary",
  "style",
  "stigma",
  "filament",
];

const family = [
  { key: "quill", aliases: [shortForm] },
  { key: "bract", aliases: [longForm] },
];

const docs = [
  { id: "zzz-exact", title: "Lumen", body: "the whole title is the typed word" },
  { id: "a-plain-title", title: "Lumen Atlas", body: "regional maps" },
  { id: "zzz-stacked", title: "Lumen Quill", body: "the typed word and the short-form key" },
  { id: "m-short-key", title: "Quill Primer", body: "unrelated foliage" },
  { id: "zzz-long-key", title: "Bract Primer", body: "unrelated foliage" },
  { id: "zzz-long-title-key", title: "Quill and Several Other Unrelated Heading Words Here Today", body: "same key in a longer title" },
  { id: "a-body", title: "Meadow Notes", body: "lumen appears once in the meadow" },
  { id: "a-body-repeat", title: "Field Notes", body: "lumen lumen lumen lumen lumen in the field" },
  { id: "a-body-key", title: "Creek Notes", body: "mentions quill without the typed word" },
];

function rankOf(results, id) {
  return results.find((row) => row.id === id).rank;
}

async function search(entries, documents, opts = {}) {
  const authored = compileAuthoredRelevance({ configuredConcepts: entries });
  const engine = SearchEngine.create({
    schema,
    plugins: [morphology(), ...authored.plugins],
    documentRelationships: opts.relationships || null,
    relationshipStrategy: opts.strategy || "none",
    retrievalScoreWeight: opts.weight ?? 0,
    retriever: opts.retriever || "full-scan",
  });
  await engine.index(documents);
  const raw = opts.query || "lumen";
  const analyzed = engine._prepareQuery(raw);
  const detailed = engine.searchDetailed(raw, {
    limit: opts.limit ?? 20,
    relatedLimit: opts.relatedLimit ?? 0,
    explain: true,
    resultCollector: opts.collector === false ? undefined : COMPLETE_INTERPRETATION_COLLECTOR,
  });
  return { analyzed, detailed };
}

describe("exact-first title evidence outside Software.Land", () => {
  test("exactCount and lastExact distinguish a completed first token from an incomplete stub", async () => {
    const exact = await search(family, docs);
    const stub = await search(family, docs, { query: "lume" });
    const group = exact.analyzed.configuredPrefixRecallGroup;
    expect(exact.analyzed.configuredSequenceIntent).toBeNull();
    expect(exact.analyzed.configuredPrefixRecall).toBeNull();
    expect(group.map((row) => row.key).sort()).toEqual(["bract", "quill"]);
    expect(group.every((row) => row.exactCount === 1 && row.lastExact && row.partialCompleteness === 0)).toBe(true);
    expect(group.find((row) => row.key === "quill").coverage).toBe(0.5);
    expect(group.find((row) => row.key === "bract").coverage).toBe(Number((1 / longForm.length).toFixed(4)));

    const stubs = stub.analyzed.configuredPrefixRecallGroup;
    expect(stubs.every((row) => row.exactCount === 0 && row.lastExact === false && row.partialCompleteness > 0)).toBe(true);
  });

  test.each(["full-scan", "indexed"])(
    "coverage-only title keys stay below a direct title token and a body hit on %s",
    async (retriever) => {
      const { detailed } = await search(family, docs, { retriever });
      const byId = Object.fromEntries(detailed.results.map((row) => [row.id, row]));
      const exact = byId["zzz-exact"];
      const plain = byId["a-plain-title"];
      const shortKey = byId["m-short-key"];
      const longKey = byId["zzz-long-key"];
      const body = byId["a-body"];
      const repeat = byId["a-body-repeat"];

      expect(exact.features.exactTitleMatch).toBe(true);
      expect(plain.features.exactTitleTokenMatch).toBe(true);
      expect(plain.features.configuredPrefixRecallScore).toBe(0);
      expect(shortKey.features.configuredPrefixRecallScore).toBeGreaterThan(0);
      expect(longKey.features.configuredPrefixRecallScore).toBeGreaterThan(0);
      expect(shortKey.directClass).toBe("none");
      expect(longKey.directClass).toBe("none");
      expect(shortKey.features.configuredConceptMatch).not.toBe("key-in-title");
      expect(longKey.features.configuredConceptMatch).not.toBe("key-in-title");
      expect(body.features.bodyLexicalMatch).toBe(1);
      expect(body.features.configuredPrefixRecallScore).toBe(0);
      expect(body.directClass).toBe("weak");
      expect(byId["a-body-key"]).toBeUndefined();

      expect(rankOf(detailed.results, "zzz-exact")).toBeLessThan(rankOf(detailed.results, "a-plain-title"));
      expect(rankOf(detailed.results, "a-plain-title")).toBeLessThan(rankOf(detailed.results, "a-body"));
      expect(rankOf(detailed.results, "a-body")).toBeLessThan(rankOf(detailed.results, "m-short-key"));
      expect(rankOf(detailed.results, "m-short-key")).toBeLessThan(rankOf(detailed.results, "zzz-long-key"));
      expect(shortKey.score).toBeGreaterThan(longKey.score);
      expect(body.score).toBeGreaterThan(shortKey.score);
      expect(plain.score).toBeGreaterThan(shortKey.score);
      expect(repeat.score).toBe(body.score);
      expect(rankOf(detailed.results, "a-body")).toBeLessThan(rankOf(detailed.results, "a-body-repeat"));

      const defs = constraintsForStrategy("none");
      expect(compareConstraint(longKey, body, defs).order).toBe(0);
      const surface = compareConstraint(plain, shortKey, defs);
      expect(surface.order).toBe(-1);
      expect(surface.applied.map((row) => row.id)).toEqual(["exact-surface-over-lemma-only"]);
      expect(compareConstraint(exact, plain, defs).applied.map((row) => row.id)).toContain("exact-title-over-non-exact");
    }
  );

  test("stored coverage is multiplied by the body-lexical coefficient", async () => {
    const { analyzed, detailed } = await search(family, docs);
    const byId = Object.fromEntries(detailed.results.map((row) => [row.id, row]));
    const shortCoverage = analyzed.configuredPrefixRecallGroup.find((row) => row.key === "quill").coverage;
    const longCoverage = analyzed.configuredPrefixRecallGroup.find((row) => row.key === "bract").coverage;
    expect(byId["m-short-key"].features.configuredPrefixRecallScore).toBe(shortCoverage);
    expect(byId["zzz-long-key"].features.configuredPrefixRecallScore).toBe(longCoverage);
    const shortPart = shortCoverage * 0.25;
    const longPart = longCoverage * 0.25;
    expect(byId["m-short-key"].score).toBeCloseTo(shortPart, 5);
    expect(byId["zzz-long-key"].score).toBeCloseTo(longPart, 5);
    expect(shortPart - longPart).toBeCloseTo((shortCoverage - longCoverage) * 0.25, 5);
    expect(byId["zzz-long-title-key"].score).toBe(byId["m-short-key"].score);
  });

  test("an incomplete stub stays on key-in-title and still suppresses body-prefix spray", async () => {
    const held = await search(family, docs, { query: "lume" });
    const open = await search(family, docs, { query: "lume", collector: false });
    for (const row of held.detailed.results) {
      expect(row.features.configuredPrefixRecallScore).toBe(0);
    }
    expect(held.detailed.results.map((row) => row.id)).not.toContain("a-body");
    expect(held.detailed.results.map((row) => row.id)).not.toContain("a-body-repeat");
    const released = open.detailed.results.find((row) => row.id === "a-body");
    const key = open.detailed.results.find((row) => row.id === "m-short-key");
    expect(released.features.configuredPrefixRecallScore).toBe(0);
    expect(released.score).toBeLessThan(key.score);
    expect(key.features.configuredConceptMatch).toBe("key-in-title");
  });

  test("a unique exact first token keeps graded coverage and loses to the weak body hit", async () => {
    const { analyzed, detailed } = await search([{ key: "quill", aliases: [shortForm] }], docs);
    expect(analyzed.configuredPrefixRecallGroup || []).toEqual([]);
    expect(analyzed.configuredPrefixRecall).toMatchObject({
      key: "quill",
      exactCount: 1,
      lastExact: true,
      coverage: 0.5,
    });
    const key = detailed.results.find((row) => row.id === "m-short-key");
    const body = detailed.results.find((row) => row.id === "a-body");
    expect(key.features.configuredPrefixRecallScore * 0.25).toBeCloseTo(0.5 * 0.25, 5);
    expect(key.score).toBeLessThan(body.score);
    expect(key.rank).toBeGreaterThan(body.rank);
  });

  test("a completed one-token alias occupies and does not store prefix coverage", async () => {
    const { analyzed, detailed } = await search([...family, { key: "lux", aliases: [["lumen"]] }], docs);
    expect(analyzed.configuredSequenceIntent?.key).toBe("lux");
    expect(analyzed.configuredPrefixRecallGroup || []).toEqual([]);
    for (const row of detailed.results) expect(row.features.configuredPrefixRecallScore || 0).toBe(0);
    expect(detailed.results[0].id).toBe("zzz-exact");
  });

  test("a title token of the typed word and a different concept key are counted once each", async () => {
    const { analyzed, detailed } = await search(family, docs);
    const plain = detailed.results.find((row) => row.id === "a-plain-title");
    const stacked = detailed.results.find((row) => row.id === "zzz-stacked");
    const coverage = analyzed.configuredPrefixRecallGroup.find((row) => row.key === "quill").coverage;
    expect(plain.features.exactTitleTokenMatch).toBe(true);
    expect(stacked.features.exactTitleTokenMatch).toBe(true);
    expect(plain.features.configuredPrefixRecallScore).toBe(0);
    expect(stacked.features.configuredPrefixRecallScore).toBe(coverage);
    expect(stacked.score - plain.score).toBeCloseTo(coverage * 0.25, 5);
    expect(stacked.score - plain.score).toBeLessThan(0.2);
    expect(stacked.rank).toBeLessThan(plain.rank);
    expect(compareConstraint(stacked, plain, constraintsForStrategy("none")).order).toBe(0);
  });

  test.each(["full-scan", "indexed"])(
    "an authored equivalent of the title key does not also store prefix coverage on %s",
    async (retriever) => {
      const documents = [
        { id: "z-key", title: "Quill Primer", body: "plain notes" },
        { id: "a-equivalent", title: "Bract Primer", body: "plain notes" },
        { id: "b-body", title: "Field Notes", body: "lumen" },
      ];
      const relationshipMap = {
        lumen: [
          { kind: "equivalent", to: { form: "quill" } },
          { kind: "equivalent", to: { form: "bract" } },
        ],
      };
      const run = async (entries) => {
        const authored = compileAuthoredRelevance({ configuredConcepts: entries, relationshipMap });
        const engine = SearchEngine.create({
          schema,
          plugins: [morphology(), ...authored.plugins],
          relationshipStrategy: "none",
          retrievalScoreWeight: 0,
          retriever,
        });
        await engine.index(documents);
        return engine.searchDetailed("lumen", { limit: 10, relatedLimit: 0, explain: true });
      };
      const without = await run([]);
      const withConcept = await run([{ key: "quill", aliases: [["lumen", "petal"]] }]);
      const plain = Object.fromEntries(without.results.map((row) => [row.id, row]));
      const configured = Object.fromEntries(withConcept.results.map((row) => [row.id, row]));
      expect(plain["a-equivalent"].score).toBe(3);
      expect(plain["z-key"].score).toBe(3);
      expect(plain["a-equivalent"].rank).toBeLessThan(plain["z-key"].rank);
      expect(configured["z-key"].features.titleCoverage).toBe(0.5);
      expect(configured["z-key"].features.queryCoverage).toBe(1);
      expect(configured["z-key"].features.configuredPrefixRecallScore).toBe(0);
      expect(configured["z-key"].score).toBe(plain["z-key"].score);
      expect(configured["a-equivalent"].score).toBe(plain["a-equivalent"].score);
      expect(configured["a-equivalent"].rank).toBeLessThan(configured["z-key"].rank);
      expect(configured["b-body"].score).toBe(plain["b-body"].score);
      expect(configured["z-key"].rank).toBeLessThan(configured["b-body"].rank);
    }
  );

  test.each(["full-scan", "indexed"])(
    "an authored equivalent of an inflected title key does not also store prefix coverage on %s",
    async (retriever) => {
      const documents = [
        { id: "z-key", title: "Quills Primer", body: "plain notes" },
        { id: "a-equivalent", title: "Bract Primer", body: "plain notes" },
        { id: "b-body", title: "Field Notes", body: "lumen" },
      ];
      const relationshipMap = {
        lumen: [
          { kind: "equivalent", to: { form: "quills" } },
          { kind: "equivalent", to: { form: "bract" } },
        ],
      };
      const run = async (entries) => {
        const authored = compileAuthoredRelevance({ configuredConcepts: entries, relationshipMap });
        const engine = SearchEngine.create({
          schema,
          plugins: [morphology(), ...authored.plugins],
          relationshipStrategy: "none",
          retrievalScoreWeight: 0,
          retriever,
        });
        await engine.index(documents);
        return engine.searchDetailed("lumen", { limit: 10, relatedLimit: 0, explain: true });
      };
      const without = await run([]);
      const withConcept = await run([{ key: "quill", aliases: [["lumen", "petal"]] }]);
      const plain = Object.fromEntries(without.results.map((row) => [row.id, row]));
      const configured = Object.fromEntries(withConcept.results.map((row) => [row.id, row]));
      expect(plain["a-equivalent"].score).toBe(3);
      expect(plain["z-key"].score).toBe(3);
      expect(plain["a-equivalent"].rank).toBeLessThan(plain["z-key"].rank);
      expect(configured["z-key"].features.titleCoverage).toBe(0.5);
      expect(configured["z-key"].features.queryCoverage).toBe(1);
      expect(configured["z-key"].features.configuredPrefixRecallScore).toBe(0);
      expect(configured["z-key"].score).toBe(plain["z-key"].score);
      expect(configured["a-equivalent"].score).toBe(plain["a-equivalent"].score);
      expect(configured["a-equivalent"].rank).toBeLessThan(configured["z-key"].rank);
      expect(configured["b-body"].score).toBe(plain["b-body"].score);
      expect(configured["z-key"].rank).toBeLessThan(configured["b-body"].rank);
    }
  );

  test("a query token that lexically prefixes the concept key does not also store coverage", async () => {
    const entries = [
      { key: "lumenose", aliases: [["lumen", "gland"]] },
      { key: "quill", aliases: [["lumen", "petal"]] },
    ];
    const documents = [
      { id: "zzz-prefixed-key", title: "Lumenose Primer", body: "unrelated foliage" },
      { id: "aaa-plain", title: "Lumen Atlas", body: "regional maps" },
    ];
    const { detailed } = await search(entries, documents);
    const prefixed = detailed.results.find((row) => row.id === "zzz-prefixed-key");
    const plain = detailed.results.find((row) => row.id === "aaa-plain");
    expect(prefixed.features.typedSurfaceTitleMatch).toBe(true);
    expect(prefixed.features.configuredPrefixRecallScore).toBe(0);
    expect(prefixed.directClass).not.toBe("none");
    expect(plain.features.configuredPrefixRecallScore).toBe(0);
    expect(prefixed.rank).toBeLessThan(plain.rank);
  });

  test.each(["full-scan", "indexed"])(
    "an absent second concept does not change contribution, score, or order on %s",
    async (retriever) => {
      const documents = [
        { id: "000-key", title: "Quill Primer", body: "unrelated foliage" },
        { id: "zzz-key-body", title: "Quill Notes", body: "lumen appears beside the key" },
        { id: "zzz-long-body", title: "Bract Notes", body: "lumen appears beside the long key" },
        { id: "zzz-lexical", title: "Lumen Quill", body: "the typed word and the concept key" },
        { id: "aaa-body", title: "Meadow Notes", body: "lumen appears once in the meadow" },
      ];
      const original = [{ key: "quill", aliases: [["lumen", "petal"]] }];
      const absent = { key: "bract", aliases: [["lumen", "sepal", "corolla"]] };
      const unique = await search(original, documents, { retriever, weight: 0, strategy: "none" });
      const ambiguous = await search([...original, absent], documents, { retriever, weight: 0, strategy: "none" });

      expect(unique.analyzed.configuredPrefixRecall).toMatchObject({
        key: "quill",
        exactCount: 1,
        lastExact: true,
        coverage: 0.5,
      });
      expect(unique.analyzed.configuredPrefixRecallGroup || []).toEqual([]);
      expect(ambiguous.analyzed.configuredPrefixRecall).toBeNull();
      expect(ambiguous.analyzed.configuredPrefixRecallGroup.map((row) => row.key).sort()).toEqual(["bract", "quill"]);
      expect(ambiguous.detailed.results.map((row) => row.id).sort()).toEqual(
        unique.detailed.results.map((row) => row.id).sort()
      );

      const uniqueById = Object.fromEntries(unique.detailed.results.map((row) => [row.id, row]));
      const ambiguousById = Object.fromEntries(ambiguous.detailed.results.map((row) => [row.id, row]));
      for (const id of ["000-key", "zzz-key-body", "zzz-lexical", "aaa-body"]) {
        expect(ambiguousById[id].features.configuredPrefixRecallScore).toBe(
          uniqueById[id].features.configuredPrefixRecallScore
        );
        expect(ambiguousById[id].score).toBe(uniqueById[id].score);
        expect(ambiguousById[id].rank < ambiguousById["aaa-body"].rank).toBe(
          uniqueById[id].rank < uniqueById["aaa-body"].rank
        );
      }
      const body = uniqueById["aaa-body"];
      const pure = uniqueById["000-key"];
      const both = uniqueById["zzz-key-body"];
      const lexical = uniqueById["zzz-lexical"];
      expect(pure.features.configuredPrefixRecallScore).toBe(0.5);
      expect(pure.directClass).toBe("none");
      expect(pure.score).toBeCloseTo(0.5 * 0.25, 5);
      expect(pure.score).toBeLessThan(body.score);
      expect(body.rank).toBeLessThan(pure.rank);
      expect(both.features.configuredPrefixRecallScore).toBe(0.5);
      expect(both.features.bodyLexicalMatch).toBe(1);
      expect(both.directClass).toBe("weak");
      expect(both.features.configuredConceptMatch).not.toBe("key-in-title");
      expect(both.score).toBeCloseTo(body.score + 0.5 * 0.25, 5);
      expect(both.rank).toBeLessThan(body.rank);
      expect(lexical.features.configuredPrefixRecallScore).toBe(0.5);
      expect(lexical.features.exactTitleTokenMatch).toBe(true);
      expect(lexical.rank).toBeLessThan(body.rank);
      const longCoverage = ambiguous.analyzed.configuredPrefixRecallGroup.find((row) => row.key === "bract").coverage;
      const uniqueLong = uniqueById["zzz-long-body"];
      const ambiguousLong = ambiguousById["zzz-long-body"];
      expect(uniqueLong.features.configuredPrefixRecallScore).toBe(0);
      expect(uniqueLong.score).toBe(body.score);
      expect(ambiguousLong.features.configuredPrefixRecallScore).toBe(longCoverage);
      expect(ambiguousLong.directClass).toBe("weak");
      expect(ambiguousLong.score).toBeCloseTo(body.score + longCoverage * 0.25, 5);
      expect(ambiguousLong.score).toBeLessThan(both.score);
      expect(ambiguousLong.rank).toBeLessThan(ambiguousById["aaa-body"].rank);
    }
  );
});
