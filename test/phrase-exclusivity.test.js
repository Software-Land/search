/**
 * Query-plan phrase cohort policy on the Software.Land fixture.
 * Token count is not a relevance primitive. Body-only rare phrases do not
 * exclusive-collapse. Title/summary rare phrases and I ⊆ P still may.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import {
  MAX_EXCLUSIVE_PHRASE_COHORT,
  documentHasExactTypedPhrase,
  exclusivePhraseDocuments,
  typedPhraseTokens,
} from "../dist/phraseExclusivity.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { loadSoftwareLandRelevanceInputs } from "./helpers/software-land-fixture.js";

const {
  documents,
  configuredConcepts,
  lemmas,
  relationshipMap,
  relationships,
  lexicalFrequency,
  schema,
} = loadSoftwareLandRelevanceInputs();

const TITLE_RARE_PHRASES = [
  {
    phrase: "linear vs logistic regression",
    titles: ["Linear vs Logistic Regression"],
  },
  {
    phrase: "static vs dynamic websites",
    titles: ["Static vs Dynamic Websites"],
  },
];

const BODY_ONLY_MUST_NOT_COLLAPSE = [
  "retries are exactly what it sounds",
  "in many programming languages",
  "a series of a",
  "entire browser process management",
  "responsible for managing",
  "for example with",
];

const ADJUDICATED_SUPPORT_SUBSET = [
  {
    query: "role based access control",
    titles: ["RBAC (Role Based Access Control)", "Authorization Middleware"],
  },
  {
    query: "platform as a service",
    titles: ["What is Kubernetes?", "What is the Cloud?"],
  },
];

function createEngine() {
  const compiled = compileAuthoredRelevance({ configuredConcepts, relationshipMap });
  return SearchEngine.create({
    schema,
    plugins: [morphology({ lemmas }), ...compiled.plugins],
    documentRelationships: relationships,
    relationshipStrategy: "hybrid",
    retriever: "full-scan",
  });
}

function publicTitles(engine, query, limit = 10) {
  return engine.search(query, { limit }).map((hit) => hit.title);
}

describe("query-plan phrase cohort on Software.Land fixture", () => {
  let engine;

  beforeAll(async () => {
    engine = createEngine();
    await engine.index(attachLexicalFrequency(documents, lexicalFrequency));
  });

  test("result-set cohort bound is 2, not a token-length gate", () => {
    expect(MAX_EXCLUSIVE_PHRASE_COHORT).toBe(2);
  });

  test("rare title phrases may collapse without using token count", () => {
    for (const { phrase, titles } of TITLE_RARE_PHRASES) {
      const analyzed = engine._prepareQuery(phrase);
      const hits = exclusivePhraseDocuments(analyzed, engine._index);
      expect(hits.map((doc) => doc.title).sort()).toEqual([...titles].sort());
      expect(publicTitles(engine, phrase).sort()).toEqual([...titles].sort());
      expect(documentHasExactTypedPhrase(typedPhraseTokens(analyzed), hits[0])).toBe(true);
    }
  });

  test("body-only rare phrases do not exclusive-collapse", () => {
    for (const query of BODY_ONLY_MUST_NOT_COLLAPSE) {
      const analyzed = engine._prepareQuery(query);
      expect(exclusivePhraseDocuments(analyzed, engine._index)).toBeNull();
      expect(publicTitles(engine, query).length).toBeGreaterThan(1);
    }
  });

  test("support subset of rare phrase keeps the accepted occupied truncations", () => {
    for (const { query, titles } of ADJUDICATED_SUPPORT_SUBSET) {
      const publicList = publicTitles(engine, query);
      expect(publicList.sort()).toEqual([...titles].sort());
    }
  });

  test("spoken HTTPS expansion stays TLS-first without equivalent HTTPS/TLS identity", () => {
    const titles = publicTitles(engine, "hypertext transfer protocol secure");
    expect(titles[0]).toBe("TLS 1.2 Vulnerability");
    expect(titles.length).toBeGreaterThan(1);
    expect(exclusivePhraseDocuments(engine._prepareQuery("hypertext transfer protocol secure"), engine._index)).toBeNull();
  });

  test("object oriented programming vs functional is not forced exclusive", () => {
    const titles = publicTitles(engine, "object oriented programming vs functional");
    expect(titles[0]).toBe("What is OOP (Object-Oriented Programming)?");
    expect(titles).toContain("OOP vs Functional");
  });

  test("dangerous occupied expansions do not collapse to the mention document", () => {
    expect(publicTitles(engine, "remote procedure call")[0]).toBe("gRPC vs REST");
    expect(publicTitles(engine, "cross site scripting")[0]).toBe("React Authentication");
    expect(publicTitles(engine, "application programming interface")[0]).toBe("What is an API?");
    expect(exclusivePhraseDocuments(engine._prepareQuery("remote procedure call"), engine._index)).toBeNull();
    expect(exclusivePhraseDocuments(engine._prepareQuery("cross site scripting"), engine._index)).toBeNull();
    expect(exclusivePhraseDocuments(engine._prepareQuery("command line interface"), engine._index)).toBeNull();
    expect(exclusivePhraseDocuments(engine._prepareQuery("simple queue service"), engine._index)).toBeNull();
    expect(exclusivePhraseDocuments(engine._prepareQuery("application programming interface"), engine._index)).toBeNull();
  });

  test("version queries do not phrase-filter", () => {
    expect(exclusivePhraseDocuments(engine._prepareQuery("tls 1.2"), engine._index)).toBeNull();
    expect(exclusivePhraseDocuments(engine._prepareQuery("1.2 vulnerability"), engine._index)).toBeNull();
    expect(publicTitles(engine, "tls 1.2")[0]).toBe("TLS 1.2 Vulnerability");
    expect(publicTitles(engine, "1.2 vulnerability")[0]).toBe("TLS 1.2 Vulnerability");
  });
});
