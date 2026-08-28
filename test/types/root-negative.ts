import { SearchEngine, morphology, compileAuthoredRelevance, migrateConfiguredEntry, ARTIFACT_FORMATS } from "@software-land/search";

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

// @ts-expect-error parseSynonyms is not a public root export
import { parseSynonyms } from "@software-land/search";

// @ts-expect-error SynonymArtifact is not a public export
import type { SynonymArtifact } from "@software-land/search";

// @ts-expect-error EquivalenceEntry is not a public export
import type { EquivalenceEntry } from "@software-land/search";

// @ts-expect-error EquivalenceArtifact is not a public export
import type { EquivalenceArtifact } from "@software-land/search";

// @ts-expect-error parseEquivalences is not a public root export
import { parseEquivalences } from "@software-land/search";

// @ts-expect-error DictionaryPlugin is not a public export
import type { DictionaryPlugin } from "@software-land/search";

// @ts-expect-error SynonymPlugin is not a public export
import type { SynonymPlugin } from "@software-land/search";

// @ts-expect-error SearchEquivalenceMap is not a public export
import type { SearchEquivalenceMap } from "@software-land/search";

// @ts-expect-error NormalizedSearchEquivalences is not a public export
import type { NormalizedSearchEquivalences } from "@software-land/search";

// @ts-expect-error normalizeSearchEquivalences is not a public root export
import { normalizeSearchEquivalences } from "@software-land/search";

// @ts-expect-error compileRelationshipMap is not a public root export
import { compileRelationshipMap } from "@software-land/search";

// @ts-expect-error CompiledRelationshipMap is not a public export
import type { CompiledRelationshipMap } from "@software-land/search";

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

// @ts-expect-error CompiledRelationshipInternals is not a public export
import type { CompiledRelationshipInternals } from "@software-land/search";

void engine;
void morphologyPlugin;
void lang;
void createEnglishPlugin;
void english;
void dictionary;
void synonyms;
void parseSynonyms;
void parseEquivalences;
void normalizeSearchEquivalences;
void compileRelationshipMap;
void (null as unknown as SynonymArtifact);
void (null as unknown as EquivalenceEntry);
void (null as unknown as EquivalenceArtifact);
void (null as unknown as DictionaryPlugin);
void (null as unknown as SynonymPlugin);
void (null as unknown as SearchEquivalenceMap);
void (null as unknown as NormalizedSearchEquivalences);
void (null as unknown as CompiledRelationshipMap);
void mergeEditorialRelationships;
void (null as unknown as CompiledRelationshipInternals);

// @ts-expect-error migrateConfiguredEntry requires an entry object
migrateConfiguredEntry();

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

// @ts-expect-error synonyms is not a supported artifact format
ARTIFACT_FORMATS.synonyms;

// @ts-expect-error equivalences is not a supported root artifact format
ARTIFACT_FORMATS.equivalences;

SearchEngine.create({
  // @ts-expect-error relationships is not a public SearchEngine.create option
  relationships: {
    format: "search-v2-relationships",
    version: 1,
    relationships: {},
  },
});

SearchEngine.create({
  plugins: [
    {
      name: "custom",
      // @ts-expect-error sequences is not a public SearchPlugin hook
      sequences: [{ tokens: ["wifi"], kind: "key", entry: { key: "wifi" } }],
    },
  ],
});

SearchEngine.create({
  plugins: [
    {
      name: "custom",
      // @ts-expect-error byKey is not a public SearchPlugin field
      byKey: new Map([["wifi", { key: "wifi" }]]),
    },
  ],
});

SearchEngine.create({
  plugins: [
    {
      name: "custom",
      // @ts-expect-error standaloneRecallByToken is not a public SearchPlugin field
      standaloneRecallByToken: new Map(),
    },
  ],
});

SearchEngine.create({
  plugins: [
    {
      name: "custom",
      // @ts-expect-error topicalRecallByKey is not a public SearchPlugin field
      topicalRecallByKey: new Map(),
    },
  ],
});

const excessSequences: import("@software-land/search").SearchPlugin = {
  name: "custom",
  // @ts-expect-error sequences is not a public SearchPlugin hook
  sequences: [{ tokens: ["wifi"], kind: "key", entry: { key: "wifi" } }],
};
void excessSequences;

const excessByKey: import("@software-land/search").SearchPlugin = {
  name: "custom",
  // @ts-expect-error byKey is not a public SearchPlugin field
  byKey: new Map([["wifi", { key: "wifi" }]]),
};
void excessByKey;

const excessStandalone: import("@software-land/search").SearchPlugin = {
  name: "custom",
  // @ts-expect-error standaloneRecallByToken is not a public SearchPlugin field
  standaloneRecallByToken: new Map(),
};
void excessStandalone;

const excessTopical: import("@software-land/search").SearchPlugin = {
  name: "custom",
  // @ts-expect-error topicalRecallByKey is not a public SearchPlugin field
  topicalRecallByKey: new Map(),
};
void excessTopical;
