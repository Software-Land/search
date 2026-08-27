import { SearchEngine, morphology, compileRelationshipMap, compileAuthoredRelevance } from "@software-land/search";

// @ts-expect-error FeatureVector is not a public export
import type { FeatureVector } from "@software-land/search";

// @ts-expect-error AnalyzedQuery is not a public export
import type { AnalyzedQuery } from "@software-land/search";

// @ts-expect-error IndexedDocument is not a public export
import type { IndexedDocument } from "@software-land/search";

// @ts-expect-error lang is not a public export
import { lang } from "@software-land/search";

// @ts-expect-error createEnglishPlugin is not a public export
import { createEnglishPlugin } from "@software-land/search";

// @ts-expect-error EnglishMorphologyOptions is not a public export
import type { EnglishMorphologyOptions } from "@software-land/search";

// @ts-expect-error MorphologyPlugin is not a public export
import type { MorphologyPlugin } from "@software-land/search";

// @ts-expect-error english is not a public root export
import { english } from "@software-land/search";

// @ts-expect-error dictionary is not a public root export
import { dictionary } from "@software-land/search";

// @ts-expect-error synonyms is not a public root export
import { synonyms } from "@software-land/search";

// @ts-expect-error mergeEditorialRelationships is not a public root export
import { mergeEditorialRelationships } from "@software-land/search";

const engine = SearchEngine.create();

// @ts-expect-error retriever is not on the public SearchEngine class
engine.retriever;

// @ts-expect-error lastSearchMeta is not on the public SearchEngine class
engine.lastSearchMeta;

// @ts-expect-error _index is not on the public SearchEngine class
engine._index;

// @ts-expect-error bm25 is not a public retriever name
SearchEngine.create({ retriever: "bm25" });

// @ts-expect-error best is not a public relationshipStrategy
SearchEngine.create({ relationshipStrategy: "best" });

const morphologyPlugin = morphology();
void morphologyPlugin.lemma;

const compiledPublic = compileRelationshipMap({
  qa: [{ to: { form: "testing" }, kind: "equivalent" }],
});

// @ts-expect-error standaloneRecallByKey is not a public compileRelationshipMap field
compiledPublic.standaloneRecallByKey;

// @ts-expect-error topicalRecallByKey is not a public compileRelationshipMap field
compiledPublic.topicalRecallByKey;

// @ts-expect-error CompiledRelationshipInternals is not a public export
import type { CompiledRelationshipInternals } from "@software-land/search";

void engine;
void morphologyPlugin;
void lang;
void createEnglishPlugin;
void english;
void dictionary;
void synonyms;
void mergeEditorialRelationships;
void compiledPublic;
void (null as unknown as CompiledRelationshipInternals);

const authored = compileAuthoredRelevance({
  configuredConcepts: [{ key: "qa", aliases: [["quality", "assurance"]] }],
  relationshipMap: { qa: [{ to: { form: "testing" }, kind: "equivalent" }] },
});

compileAuthoredRelevance({
  // @ts-expect-error entries is not a public compileAuthoredRelevance option
  entries: [{ key: "qa", aliases: [["quality", "assurance"]] }],
});

// @ts-expect-error dictionary is not a public CompiledAuthoredRelevance field
authored.dictionary;

// @ts-expect-error synonyms is not a public CompiledAuthoredRelevance field
authored.synonyms;

// @ts-expect-error synonymMap is not a public CompiledAuthoredRelevance field
authored.synonymMap;

// @ts-expect-error editorialRelationships is not a public CompiledAuthoredRelevance field
authored.editorialRelationships;

// @ts-expect-error relationships is not a public CompiledAuthoredRelevance field
authored.relationships;

SearchEngine.create({
  // @ts-expect-error relationships is not a public SearchEngine.create option
  relationships: {
    format: "search-v2-relationships",
    version: 1,
    relationships: {},
  },
});
