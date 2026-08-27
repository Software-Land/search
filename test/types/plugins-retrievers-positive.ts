/**
 * 0.4.0 plugin/retriever authoring: SearchPlugin[] and ExperimentalRetriever.
 */
import {
  SearchEngine,
  dictionary,
  morphology,
  type DictionaryPlugin,
  type EnglishPlugin,
  type ExperimentalRetrieveOptions,
  type ExperimentalRetriever,
  type LexiconPlugin,
  type SearchPlugin,
  type SynonymPlugin,
} from "@software-land/search";

const jsShaped = {
  lemma(token: string) {
    return token;
  },
  extra: true,
};
SearchEngine.create({ plugins: [jsShaped] });
SearchEngine.create({ plugins: [morphology(), dictionary()] });
const fromMorphology: EnglishPlugin = morphology();
void fromMorphology.lemma;
const fromDictionary: DictionaryPlugin = dictionary({ entries: [{ key: "wifi" }] });
void fromDictionary.lexicon;

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
  sequences: [{ tokens: ["wifi"], kind: "key", entry: { key: "wifi", aliases: [["wi", "fi"]]} }],
  byKey: new Map([["wifi", { key: "wifi", aliases: [["wi", "fi"]]}]]),
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
void s.expand;

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
