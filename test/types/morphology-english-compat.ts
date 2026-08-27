/**
 * morphology() returns EnglishPlugin.
 * compileAuthoredRelevance() produces DictionaryPlugin as authored.plugins identity.
 * Root english() is removed. Root dictionary() is removed.
 */
import {
  compileAuthoredRelevance,
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

const plugin: EnglishPlugin = morphology();
void plugin.name;
void plugin.indexIdentity;
void plugin.lemma("widgets");
void plugin.canonicalLemma("widgets");
// @ts-expect-error lemmaTableKeys is not a public EnglishPlugin hook
void plugin.lemmaTableKeys;

const withMap: EnglishPlugin = morphology({ lemmas: { widgets: "widget" } });
void withMap.lemma("widgets");

const dict = compileAuthoredRelevance({ configuredConcepts: [{ key: "wifi" }] }).plugins.find(
  (plugin): plugin is DictionaryPlugin => plugin.name === "dictionary"
);
if (!dict) throw new Error("compileAuthoredRelevance must include the dictionary plugin");
void dict.name;
void dict.lexicon;

void options;
void withLemmas;
void morphologyFn;
void english;
