import { SearchEngine, english, morphology } from "@software-land/search";

// @ts-expect-error FeatureVector is not a public export
import type { FeatureVector } from "@software-land/search";

// @ts-expect-error AnalyzedQuery is not a public export
import type { AnalyzedQuery } from "@software-land/search";

// @ts-expect-error IndexedDocument is not a public export
import type { IndexedDocument } from "@software-land/search";

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

const plugin = english();
const morphologyPlugin = morphology();
// @ts-expect-error public english() is unknown, not an implementation plugin shape
plugin.lemma;
void morphologyPlugin.lemma;

void engine;
void plugin;
void morphologyPlugin;
