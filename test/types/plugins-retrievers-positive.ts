/**
 * 0.4.0 plugin/retriever authoring: SearchPlugin[] and ExperimentalRetriever.
 */
import {
  SearchEngine,
  morphology,
  compileAuthoredRelevance,
  type EnglishPlugin,
  type ExperimentalRetrieveOptions,
  type ExperimentalRetriever,
  type LexiconPlugin,
  type SearchPlugin,
} from "@software-land/search";

const jsShaped = {
  lemma(token: string) {
    return token;
  },
  extra: true,
};
SearchEngine.create({ plugins: [jsShaped] });
SearchEngine.create({
  plugins: [morphology(), ...compileAuthoredRelevance({ configuredConcepts: [{ key: "wifi" }] }).plugins],
});
const fromMorphology: EnglishPlugin = morphology();
void fromMorphology.lemma;
const fromAuthored = compileAuthoredRelevance({ configuredConcepts: [{ key: "wifi" }] }).plugins[0];
if (!fromAuthored) throw new Error("compileAuthoredRelevance must include configured-concept plugins");
void fromAuthored.lexicon?.();

SearchEngine.create({
  retriever: {
    retrieve: () => [],
    retrieveAsync: async () => [],
    prepare: () => {},
    name: "custom",
  },
});

const p: SearchPlugin = {
  name: "custom-morphology",
  indexIdentity: "custom-morphology-v1",
  lemma(token: string) {
    return token;
  },
  canonicalLemma() {
    return null;
  },
};

const e: EnglishPlugin = {
  name: "english",
  lemma(token: string) {
    return token;
  },
  canonicalLemma() {
    return null;
  },
};

const d: SearchPlugin = {
  name: "custom-lexicon",
  indexIdentity: "custom-lexicon-v1",
  lexicon() {
    return ["wifi", "wi", "fi"];
  },
};

const l: LexiconPlugin = {
  name: "corpus-spelling-lexicon",
  lexicon() {
    return ["kubernetes"];
  },
};

const r: ExperimentalRetriever = {
  retrieve() {
    return [];
  },
};

const rFull: ExperimentalRetriever = {
  name: "custom",
  prepare(index: unknown, extra?: { schema?: unknown }) {
    void index;
    void extra;
  },
  retrieve(query: unknown, index: unknown, options?: ExperimentalRetrieveOptions) {
    void query;
    void index;
    void options;
    return [];
  },
  async retrieveAsync() {
    return [];
  },
};

SearchEngine.create({ plugins: [p, e, d, l] });
SearchEngine.create({ retriever: r });
SearchEngine.create({ retriever: rFull });

const plugins: SearchPlugin[] = [p, e, d, l];
SearchEngine.create({ plugins });
