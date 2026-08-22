import { SearchEngine, english, morphology } from "@software-land/search";
import type {
  ExperimentalRetriever,
  SearchPlugin,
} from "@software-land/search";

// @ts-expect-error FeatureVector is not a public export
import type { FeatureVector } from "@software-land/search";

// @ts-expect-error AnalyzedQuery is not a public export
import type { AnalyzedQuery } from "@software-land/search";

// @ts-expect-error IndexedDocument is not a public export
import type { IndexedDocument } from "@software-land/search";

// @ts-expect-error SearchIndex is not a public export
import type { SearchIndex } from "@software-land/search";

const plugin = english();
const morphologyPlugin = morphology();
// @ts-expect-error public english() is unknown, not an implementation plugin shape
plugin.lemma;
void morphologyPlugin.lemma;

const badLemma: SearchPlugin = {
  // @ts-expect-error lemma must be a function when provided
  lemma: 123,
};

const badCanonical: SearchPlugin = {
  // @ts-expect-error canonicalLemma must be a function when provided
  canonicalLemma: "no",
};

const badLexicon: SearchPlugin = {
  // @ts-expect-error lexicon must be a function when provided
  lexicon: ["wifi"],
};

const badExpand: SearchPlugin = {
  // @ts-expect-error expand must be a function when provided
  expand: true,
};

const badSequenceTokens: SearchPlugin = {
  sequences: [
    // @ts-expect-error sequences[].tokens is required once sequences is present
    {
      kind: "key",
      entry: { key: "wifi" },
    },
  ],
};

const badSequenceEntry: SearchPlugin = {
  sequences: [
    // @ts-expect-error sequences[].entry is required once sequences is present
    {
      tokens: ["wifi"],
      kind: "key",
    },
  ],
};

// @ts-expect-error ExperimentalRetriever requires retrieve
const missingRetrieve: ExperimentalRetriever = {
  name: "custom",
  retrieveAsync: async () => [],
};

const badRetrieveReturn: ExperimentalRetriever = {
  // @ts-expect-error retrieve must return an array
  retrieve() {
    return 0;
  },
};

const badRetrieveAsync: ExperimentalRetriever = {
  retrieve() {
    return [];
  },
  // @ts-expect-error retrieveAsync must return a Promise
  retrieveAsync() {
    return [];
  },
};

void SearchEngine;
void plugin;
void morphologyPlugin;
void badLemma;
void badCanonical;
void badLexicon;
void badExpand;
void badSequenceTokens;
void badSequenceEntry;
void missingRetrieve;
void badRetrieveReturn;
void badRetrieveAsync;
