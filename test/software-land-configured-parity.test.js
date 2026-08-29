/**
 * Exhaustive Software.Land fixture audit: unambiguous key/alias forms of one
 * configured concept must produce identical ranked results, except when a
 * typed form activates independent phrase-cohort restriction (rare exact
 * phrase whose title-grade support set is covered by that cohort, or an unoccupied
 * title/summary phrase). That narrowing of a long configured alias/form
 * relative to its short configured key is an explicit exception to ordinary
 * key/form result parity, not an accidental occupancy regression. Occupancy
 * key is unchanged in that case.
 * Fixture-only. Not Core default ranking policy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import { exclusivePhraseDocuments } from "../dist/phraseExclusivity.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");
const LIMIT = 50;

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

function aliasKey(alias) {
  return JSON.stringify(Array.isArray(alias) ? alias : []);
}

function applyConfiguredConceptPatches(entries, patches) {
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
const omitKeys = new Set(relevanceConfig.omitConfiguredConceptKeys || []);
const configuredConcepts = applyConfiguredConceptPatches(
  loadJson("configured-concepts.json").filter((entry) => !omitKeys.has(entry.key)),
  relevanceConfig.configuredConceptPatches
);

function formText(form) {
  return Array.isArray(form) ? form.join(" ") : String(form || "");
}

function publicView(engine, plugins, raw) {
  const analyzed = analyzeQuery(raw, { plugins });
  const detailed = engine.searchDetailed(raw, { limit: LIMIT, relatedLimit: 8 });
  return {
    key: analyzed.configuredSequenceIntent?.key ?? null,
    candidateCount: detailed.meta.candidateCount,
    ids: detailed.results.map((h) => h.id),
    scores: detailed.results.map((h) => h.score),
    relevanceKind: detailed.results.map((h) => h.relevanceKind),
    directClass: detailed.results.map((h) => h.directClass),
    relatedIds: (detailed.related || []).map((h) => h.id),
  };
}

function activatesPhraseExclusivity(engine, raw) {
  return exclusivePhraseDocuments(engine._prepareQuery(raw), engine._index) != null;
}

function expectSameConceptViews(engine, views) {
  const nonExclusive = views.filter(({ q }) => !activatesPhraseExclusivity(engine, q));
  const exclusive = views.filter(({ q }) => activatesPhraseExclusivity(engine, q));
  for (const row of views) expect(row.view.key).toBe(views[0].view.key);
  for (let i = 1; i < nonExclusive.length; i++) {
    expect(nonExclusive[i].view).toEqual(nonExclusive[0].view);
  }
  for (const row of exclusive) {
    expect(row.view.ids.length).toBeGreaterThan(0);
    expect(row.view.ids.length).toBeLessThanOrEqual(2);
  }
}

describe("Software.Land configured-concept result parity", () => {
  let engine;
  let engines;
  let plugins;

  beforeAll(async () => {
    const compiled = compileAuthoredRelevance({ configuredConcepts: configuredConcepts,
      relationshipMap: loadJson(relevanceConfig.relationshipMapFile).map,
    });
    plugins = [
      morphology({ lemmas: loadJson("lemmas.json") }),
      ...compiled.plugins,
    ];
    const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
    const docs = attachLexicalFrequency(loadJson("documents.json"), loadJson("lexical-frequency.json"));
    const rel = loadJson("relationships.json");
    engines = {};
    for (const retriever of ["full-scan", "indexed", "adaptive"]) {
      engines[retriever] = SearchEngine.create({
        schema,
        plugins,
        documentRelationships: rel,
        relationshipStrategy: "hybrid",
        retriever,
      });
      await engines[retriever].index(docs);
    }
    engine = engines["full-scan"];
  });

  test("every occupying key/alias pair of one concept has identical results", () => {
    const dict = plugins[1];
    const byKey = new Map();
    for (const entry of dict.byKey.values()) {
      const seen = new Set();
      const forms = [[entry.key], ...(entry.aliases || [])];
      for (const form of forms) {
        if (!form?.length) continue;
        const q = formText(form);
        if (!q || seen.has(q)) continue;
        seen.add(q);
        const view = publicView(engine, plugins, q);
        if (view.key !== entry.key) continue;
        if (!byKey.has(entry.key)) byKey.set(entry.key, []);
        byKey.get(entry.key).push({ q, view });
      }
    }
    const divergences = [];
    let pairwise = 0;
    for (const [key, rows] of byKey) {
      if (rows.length < 2) continue;
      const base = rows[0].view;
      for (let i = 1; i < rows.length; i++) {
        pairwise += 1;
        const other = rows[i].view;
        if (activatesPhraseExclusivity(engine, rows[0].q) || activatesPhraseExclusivity(engine, rows[i].q)) {
          continue;
        }
        const same =
          other.candidateCount === base.candidateCount &&
          JSON.stringify(other.ids) === JSON.stringify(base.ids) &&
          JSON.stringify(other.scores) === JSON.stringify(base.scores) &&
          JSON.stringify(other.relevanceKind) === JSON.stringify(base.relevanceKind) &&
          JSON.stringify(other.directClass) === JSON.stringify(base.directClass) &&
          JSON.stringify(other.relatedIds) === JSON.stringify(base.relatedIds);
        if (!same) divergences.push({ key, a: rows[0].q, b: rows[i].q });
      }
    }
    expect({ pairwise, divergences }).toEqual({ pairwise, divergences: [] });
  });

  test("ci matches continuous integration and cd matches continuous deployment", () => {
    const ci = publicView(engine, plugins, "ci");
    const ciExp = publicView(engine, plugins, "continuous integration");
    expect(ci.key).toBe("ci");
    expect(ciExp.key).toBe("ci");
    const cd = publicView(engine, plugins, "cd");
    const cdExp = publicView(engine, plugins, "continuous deployment");
    expect(cd.key).toBe("cd");
    expect(cdExp.key).toBe("cd");
    expectSameConceptViews(engine, [
      { q: "ci", view: ci },
      { q: "continuous integration", view: ciExp },
    ]);
    expectSameConceptViews(engine, [
      { q: "cd", view: cd },
      { q: "continuous deployment", view: cdExp },
    ]);
  });

  test("cicd family and paas family share results", () => {
    const cicdForms = ["cicd", "ci cd", "ci/cd", "continuous integration continuous deployment"];
    const views = cicdForms.map((q) => [q, publicView(engine, plugins, q)]);
    for (const [q, view] of views) {
      expect({ q, key: view.key }).toEqual({ q, key: "cicd" });
      expect(view).toEqual(views[0][1]);
    }
    const paasForms = ["paas", "platform service", "platform as a service"];
    const paas = paasForms.map((q) => ({ q, view: publicView(engine, plugins, q) }));
    expectSameConceptViews(engine, paas);
  });

  test("same-concept families stay equivalent within indexed and adaptive", () => {
    const families = [
      ["ci", "continuous integration"],
      ["cd", "continuous deployment"],
      ["cicd", "ci cd", "ci/cd", "continuous integration continuous deployment"],
      ["paas", "platform service", "platform as a service"],
    ];
    for (const retriever of ["indexed", "adaptive"]) {
      for (const forms of families) {
        const views = forms.map((q) => ({ q, view: publicView(engines[retriever], plugins, q) }));
        expectSameConceptViews(engines[retriever], views);
      }
    }
  });
});
