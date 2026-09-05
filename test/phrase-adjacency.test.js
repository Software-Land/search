import { SearchEngine, morphology } from "../dist/index.js";
import { extractFeatures } from "../dist/features/features.js";
import { compileLexicalIndex, loadLexicalIndex } from "../dist/indexing/lexicalIndex.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function plugins() {
  return [morphology({ lemmas: { running: "run", mice: "mouse" } })];
}

async function pair(docs) {
  const plump = plugins();
  const fat = SearchEngine.create({ schema, plugins: plump, retriever: "full-scan", relationshipStrategy: "none" });
  const artifact = compileLexicalIndex(docs, { schema, plugins: plump });
  const compact = SearchEngine.create({
    schema,
    plugins: plump,
    retriever: "indexed",
    lexicalIndex: artifact,
    relationshipStrategy: "none",
  });
  await fat.index(docs);
  await compact.index(docs);
  const loaded = loadLexicalIndex(artifact, docs, schema, plump);
  return { fat, compact, loaded };
}

function publicHits(value) {
  return { results: value.results, related: value.related };
}

describe("compact phrase adjacency", () => {
  test("title adjacency is 1 and body adjacency is 0.5", async () => {
    const docs = [
      { id: "title-hit", title: "Virtual private network guide", body: "unrelated notes" },
      { id: "body-hit", title: "Notes", body: "a virtual private network tunnel" },
      { id: "none", title: "Other", body: "virtual machines and a private club network" },
      { id: "overlap", title: "Virtual virtual private network", body: "none" },
      { id: "repeat", title: "Notes", body: "to be or not to be" },
    ];
    const { fat, compact, loaded } = await pair(docs);
    const query = fat._prepareQuery("virtual private network");
    expect(extractFeatures(query, loaded.documents.find((d) => d.id === "title-hit")).phraseAdjacency).toBe(1);
    expect(extractFeatures(query, loaded.documents.find((d) => d.id === "body-hit")).phraseAdjacency).toBe(0.5);
    expect(extractFeatures(query, loaded.documents.find((d) => d.id === "none")).phraseAdjacency).toBe(0);
    expect(extractFeatures(query, loaded.documents.find((d) => d.id === "overlap")).phraseAdjacency).toBe(1);
    for (const doc of loaded.documents) {
      const fatDoc = fat._index.documents.find((d) => d.id === doc.id);
      expect(extractFeatures(query, doc)).toEqual(extractFeatures(query, fatDoc));
    }
    expect(publicHits(compact.searchDetailed("virtual private network", { limit: 10, relatedLimit: 0 }))).toEqual(
      publicHits(fat.searchDetailed("virtual private network", { limit: 10, relatedLimit: 0 }))
    );
  });

  test("lemma adjacency matches surface-differing morphology", async () => {
    const docs = [
      { id: "lemma-title", title: "Mice running course", body: "notes" },
      { id: "lemma-body", title: "Notes", body: "the mice running tonight" },
    ];
    const { fat, loaded } = await pair(docs);
    const query = fat._prepareQuery("mouse run");
    for (const doc of loaded.documents) {
      const fatDoc = fat._index.documents.find((d) => d.id === doc.id);
      expect(extractFeatures(query, doc)).toEqual(extractFeatures(query, fatDoc));
    }
    expect(extractFeatures(query, loaded.documents.find((d) => d.id === "lemma-title")).phraseAdjacency).toBe(1);
    expect(extractFeatures(query, loaded.documents.find((d) => d.id === "lemma-body")).phraseAdjacency).toBe(0.5);
  });

  test("prefix-capable adjacency and missing terms stay exact vs fat", async () => {
    const docs = [
      { id: "prefix-title", title: "Virtualization privately networked", body: "x" },
      { id: "digits", title: "TLS 1 2 notes", body: "section 1 2 overview" },
      { id: "empty", title: "Solo", body: "" },
    ];
    const { fat, loaded } = await pair(docs);
    for (const text of ["virtual private network", "1 2", "no such phrase here"]) {
      const query = fat._prepareQuery(text);
      for (const doc of loaded.documents) {
        const fatDoc = fat._index.documents.find((d) => d.id === doc.id);
        expect(extractFeatures(query, doc)).toEqual(extractFeatures(query, fatDoc));
      }
    }
  });
});
