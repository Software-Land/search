/**
 * morphology() returns EnglishPlugin.
 * dictionary() returns DictionaryPlugin.
 * Root english() is removed.
 */
import {
  dictionary,
  morphology,
  type DictionaryPlugin,
  type EnglishPlugin,
  type MorphologyOptions,
} from "@software-land/search";

// @ts-expect-error english is not a public root export
import { english } from "@software-land/search";

const options: MorphologyOptions = {};
const withLemmas: MorphologyOptions = { lemmas: { widgets: "widget" } };

const morphologyFn: (options?: MorphologyOptions) => EnglishPlugin = morphology;
const dictionaryFn: (options?: { entries?: { key: string }[] }) => DictionaryPlugin = dictionary;

const plugin: EnglishPlugin = morphology();
void plugin.name;
void plugin.lemma("widgets");
void plugin.canonicalLemma("widgets");

const withMap: EnglishPlugin = morphology({ lemmas: { widgets: "widget" } });
void withMap.lemma("widgets");

const dict: DictionaryPlugin = dictionary();
void dict.name;
void dict.lexicon;

void options;
void withLemmas;
void morphologyFn;
void dictionaryFn;
void english;
