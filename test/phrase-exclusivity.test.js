/**
 * 0.6.0 long-phrase exclusivity. Additive coverage with real contiguous
 * Software.Land excerpts. Pins MIN=4 as the product boundary.
 * Operates on the typed surface, so a long configured alias/form may
 * exclusive-collapse while its short configured key does not. That is an
 * explicit exception to ordinary configured key/form result parity, not an
 * accidental identity regression.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import {
  MAX_PHRASE_DOCUMENT_FREQUENCY,
  MIN_PHRASE_TOKENS,
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

const UNIQUE_PHRASES = [
  { phrase: "retries are exactly what it sounds", title: "Retries (Retry Patterns)" },
  { phrase: "saml and oauth are orthogonal concepts", title: "SAML vs OAuth" },
  { phrase: "rate limiting is a concept that", title: "Rate Limiting" },
  { phrase: "before exploring the differences between rest", title: "REST API vs GraphQL" },
  { phrase: "the concept of vertical vs horizontal", title: "Sharding" },
  { phrase: "what is the difference between software", title: "Software Engineer vs Software Developer" },
  { phrase: "this blog contains information i wish", title: "About this Blog" },
  { phrase: "protobufs a are the preferred messaging", title: "Protobuf Encoding" },
  { phrase: "there are already great sources that", title: "RBAC (Role Based Access Control)" },
  { phrase: "and fundamental forms of communication between", title: "Request Response" },
];

const SHARED_TWO_DOC_PHRASES = [
  {
    phrase: "communication between microservices in a distributed",
    titles: ["Protobuf Encoding", "gRPC vs REST"],
  },
  {
    phrase: "between microservices in a distributed system",
    titles: ["Protobuf Encoding", "gRPC vs REST"],
  },
];

const SHARED_THREE_PLUS_PHRASES = [
  "be updated with diagrams after text",
  "after text used for llm training",
];

const ABSENT_PHRASES = [
  "this exact six token phrase nowhere",
  "contiguous excerpt that does not exist here at all",
];

const SHORT_QUERIES = [
  "distributed systems",
  "load balancer",
  "async programming",
  "machine learning",
  "idempotency keys",
  "vpn",
  "appsec",
  "tls",
];

const FOUR_TOKEN_ACTIVATIONS = [
  {
    phrase: "linear vs logistic regression",
    titles: ["Linear vs Logistic Regression"],
  },
  {
    phrase: "static vs dynamic websites",
    titles: ["Static vs Dynamic Websites"],
  },
];

const ADJUDICATED_QUERIES = [
  {
    query: "role based access control",
    titles: ["RBAC (Role Based Access Control)", "Authorization Middleware"],
    nonPhrase: [
      "Working with APIs",
      "SAML vs OAuth",
      "CockroachDB vs Postgres",
      "React Authentication",
    ],
  },
  {
    query: "platform as a service",
    titles: ["What is Kubernetes?", "What is the Cloud?"],
    nonPhrase: [
      "What is a Container?",
      "Distributed Cloud",
      "Encapsulation",
      "What is Cloud Migration?",
      "What is IoT?",
      "What is Serverless?",
      "Cloud Ingress Egress",
      "gRPC vs REST",
    ],
  },
  {
    query: "hypertext transfer protocol secure",
    titles: ["TLS 1.2 Vulnerability"],
    nonPhrase: [
      "gRPC vs REST",
      "TCP vs UDP",
      "React Authentication",
      "Vite React",
      "CloudFront Signed Cookies",
      "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
      "Bearer Token",
    ],
  },
  {
    query: "object oriented programming vs functional",
    titles: ["What is OOP (Object-Oriented Programming)?"],
    nonPhrase: [
      "OOP vs Functional",
      "Functional vs Procedural",
      "Object",
      "Class vs Interface",
      "Declarative vs Imperative",
    ],
  },
];

const THREE_TOKEN_NON_ACTIVATIONS = [
  "rate limiting algorithms",
  "responsible for managing",
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

describe("0.6.0 long-phrase exclusivity", () => {
  let engine;

  beforeAll(async () => {
    engine = createEngine();
    await engine.index(attachLexicalFrequency(documents, lexicalFrequency));
  });

  test("activation constants are 4 tokens and DF <= 2", () => {
    expect(MIN_PHRASE_TOKENS).toBe(4);
    expect(MAX_PHRASE_DOCUMENT_FREQUENCY).toBe(2);
  });

  test("unique contiguous excerpts collapse public results to that document", () => {
    for (const { phrase, title } of UNIQUE_PHRASES) {
      const analyzed = engine._prepareQuery(phrase);
      const tokens = typedPhraseTokens(analyzed);
      expect(tokens.length).toBeGreaterThanOrEqual(6);
      const hits = exclusivePhraseDocuments(analyzed, engine._index);
      expect(hits.map((doc) => doc.title)).toEqual([title]);
      const doc = hits[0];
      expect(documentHasExactTypedPhrase(tokens, doc)).toBe(true);
      expect(publicTitles(engine, phrase)).toEqual([title]);
    }
  });

  test("two-document phrases collapse public results to those documents", () => {
    for (const { phrase, titles } of SHARED_TWO_DOC_PHRASES) {
      const analyzed = engine._prepareQuery(phrase);
      const hits = exclusivePhraseDocuments(analyzed, engine._index);
      expect(hits.map((doc) => doc.title).sort()).toEqual([...titles].sort());
      expect(publicTitles(engine, phrase).sort()).toEqual([...titles].sort());
    }
  });

  test("four-token rare phrases activate exclusivity", () => {
    for (const { phrase, titles } of FOUR_TOKEN_ACTIVATIONS) {
      const analyzed = engine._prepareQuery(phrase);
      expect(typedPhraseTokens(analyzed).length).toBeGreaterThanOrEqual(4);
      expect(typedPhraseTokens(analyzed).length).toBeLessThan(6);
      const hits = exclusivePhraseDocuments(analyzed, engine._index);
      expect(hits.map((doc) => doc.title).sort()).toEqual([...titles].sort());
      expect(publicTitles(engine, phrase).sort()).toEqual([...titles].sort());
    }
  });

  test("adjudicated existing queries collapse to the exact phrase cohort", () => {
    for (const { query, titles, nonPhrase } of ADJUDICATED_QUERIES) {
      const analyzed = engine._prepareQuery(query);
      expect(typedPhraseTokens(analyzed).length).toBeGreaterThanOrEqual(MIN_PHRASE_TOKENS);
      const hits = exclusivePhraseDocuments(analyzed, engine._index);
      expect(hits.map((doc) => doc.title).sort()).toEqual([...titles].sort());
      const publicList = publicTitles(engine, query);
      expect(publicList.sort()).toEqual([...titles].sort());
      for (const title of nonPhrase) {
        expect(publicList).not.toContain(title);
      }
    }
  });

  test("three-token rare phrases do not trigger exclusivity", () => {
    for (const query of THREE_TOKEN_NON_ACTIVATIONS) {
      const analyzed = engine._prepareQuery(query);
      expect(typedPhraseTokens(analyzed)).toHaveLength(3);
      expect(exclusivePhraseDocuments(analyzed, engine._index)).toBeNull();
      const publicList = publicTitles(engine, query);
      expect(publicList.length).toBeGreaterThan(2);
    }
  });

  test("DF 0 and DF >= 3 do not exclusive-collapse", () => {
    for (const phrase of ABSENT_PHRASES) {
      const analyzed = engine._prepareQuery(phrase);
      expect(typedPhraseTokens(analyzed).length).toBeGreaterThanOrEqual(6);
      expect(exclusivePhraseDocuments(analyzed, engine._index)).toBeNull();
      expect(engine.search(phrase, { limit: 5 }).length).toBeGreaterThan(0);
    }
    for (const phrase of SHARED_THREE_PLUS_PHRASES) {
      const analyzed = engine._prepareQuery(phrase);
      const hits = exclusivePhraseDocuments(analyzed, engine._index);
      expect(hits).toBeNull();
      expect(engine.search(phrase, { limit: 10 }).length).toBeGreaterThan(2);
    }
  });

  test("ordinary short queries do not activate exclusivity", () => {
    for (const query of SHORT_QUERIES) {
      const analyzed = engine._prepareQuery(query);
      expect(typedPhraseTokens(analyzed).length).toBeLessThan(MIN_PHRASE_TOKENS);
      expect(exclusivePhraseDocuments(analyzed, engine._index)).toBeNull();
      expect(engine.search(query, { limit: 8 }).length).toBeGreaterThan(1);
    }
  });

  test("phrase identity is typed surface, not lemma or synonym rewrite", () => {
    const analyzed = engine._prepareQuery("retries are exactly what it sounds");
    expect(typedPhraseTokens(analyzed)).toEqual(["retries", "are", "exactly", "what", "it", "sounds"]);
    const lemmaQuery = engine._prepareQuery("retry are exactly what it sound");
    expect(exclusivePhraseDocuments(lemmaQuery, engine._index)).toBeNull();
  });
});
