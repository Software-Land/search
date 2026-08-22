/**
 * morphology() returns EnglishPlugin.
 * english() keeps the 0.3.1 unknown facade.
 */
import {
  dictionary,
  english,
  morphology,
  type EnglishPlugin,
  type MorphologyOptions,
} from "@software-land/search";

const options: MorphologyOptions = {};
const withLemmas: MorphologyOptions = { lemmas: { widgets: "widget" } };

const morphologyFn: (options?: MorphologyOptions) => EnglishPlugin = morphology;
const englishFn: (options?: { lemmas?: Record<string, string> }) => unknown = english;

const plugin: EnglishPlugin = morphology();
void plugin.name;
void plugin.lemma("widgets");
void plugin.canonicalLemma("widgets");

const withMap: EnglishPlugin = morphology({ lemmas: { widgets: "widget" } });
void withMap.lemma("widgets");

const legacy = english();
// @ts-expect-error public english() is unknown, not an implementation plugin shape
legacy.lemma;

void options;
void withLemmas;
void morphologyFn;
void englishFn;
void dictionary();
