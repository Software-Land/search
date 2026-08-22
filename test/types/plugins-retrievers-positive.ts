/**
 * 0.3.0-compatible plugin/retriever usage plus 0.3.1 opt-in authoring types.
 * create() slots stay unknown[] / { retrieve: Function }.
 */
import {
  SearchEngine,
  dictionary,
  english,
  morphology,
  type DictionaryPlugin,
  type EnglishPlugin,
  type ExperimentalRetrieveOptions,
  type ExperimentalRetriever,
  type LexiconPlugin,
  type SearchPlugin,
  type SynonymPlugin,
} from "@software-land/search";

const unknownPlugins: unknown[] = [
  morphology(),
  english(),
  dictionary({ entries: [{ key: "wifi" }] }),
  { arbitrary: true },
  1,
  "x",
  null,
];
SearchEngine.create({ plugins: unknownPlugins });

const jsShaped = {
  lemma(token: string) {
    return token;
  },
  extra: true,
};
SearchEngine.create({ plugins: [jsShaped] });
SearchEngine.create({ plugins: [morphology(), english(), dictionary()] });
const fromMorphology: EnglishPlugin = morphology();
void fromMorphology.lemma;

const retrieveFn: Function = () => [];
SearchEngine.create({ retriever: { retrieve: retrieveFn } });
SearchEngine.create({
  retriever: {
    retrieve: () => [],
    retrieveAsync: async () => [],
    prepare: () => {},
    name: "custom",
  },
});

const p: SearchPlugin = {
  lemma(token: string) {
    return token;
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

const d: DictionaryPlugin = {
  name: "dictionary",
  sequences: [{ tokens: ["wifi"], kind: "key", entry: { key: "wifi", expansion: ["wi", "fi"] } }],
  byKey: new Map([["wifi", { key: "wifi", expansion: ["wi", "fi"] }]]),
  lexicon() {
    return ["wifi", "wi", "fi"];
  },
};

const s: SynonymPlugin = {
  name: "synonyms",
  expand(token: string) {
    return [{ form: token }];
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

SearchEngine.create({ plugins: [p, e, d, s, l] });
SearchEngine.create({ retriever: r });
SearchEngine.create({ retriever: rFull });

const plugins: SearchPlugin[] = [p, e, d, s, l];
SearchEngine.create({ plugins });
