import { SearchEngine, morphology } from "@software-land/search";
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

const morphologyPlugin = morphology();
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
  // @ts-expect-error expand is not a public SearchPlugin hook
  expand(token: string) {
    return [{ form: token }];
  },
};

const badSequences: SearchPlugin = {
  // @ts-expect-error sequences is not a public SearchPlugin hook
  sequences: [{ tokens: ["wifi"], kind: "key", entry: { key: "wifi" } }],
};

const badByKey: SearchPlugin = {
  // @ts-expect-error byKey is not a public SearchPlugin field
  byKey: new Map([["wifi", { key: "wifi" }]]),
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

// @ts-expect-error plugins is SearchPlugin[], not unknown[]
SearchEngine.create({ plugins: [1] });

// @ts-expect-error plugins is SearchPlugin[], not unknown[]
SearchEngine.create({ plugins: ["x"] });

const retrieveFn: Function = () => [];
// @ts-expect-error untyped { retrieve: Function } is not the declared retriever API
SearchEngine.create({ retriever: { retrieve: retrieveFn } });

void SearchEngine;
void morphologyPlugin;
void badLemma;
void badCanonical;
void badLexicon;
void badExpand;
void badSequences;
void badByKey;
void missingRetrieve;
void badRetrieveReturn;
void badRetrieveAsync;
