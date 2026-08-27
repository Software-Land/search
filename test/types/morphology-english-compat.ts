/**
 * morphology() returns EnglishPlugin.
 * compileAuthoredRelevance() produces SearchPlugin[] as authored.plugins.
 * Root english() is removed. Root dictionary() is removed.
 */
import {
  compileAuthoredRelevance,
  morphology,
  type EnglishPlugin,
  type MorphologyOptions,
  type SearchPlugin,
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

const authoredPlugins: SearchPlugin[] = compileAuthoredRelevance({
  configuredConcepts: [{ key: "wifi" }],
}).plugins;
const identity = authoredPlugins[0];
if (!identity) throw new Error("compileAuthoredRelevance must include configured-identity plugins");
void identity.name;
void identity.lexicon?.();

void options;
void withLemmas;
void morphologyFn;
void english;
