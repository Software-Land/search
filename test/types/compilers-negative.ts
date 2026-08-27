import { compileCorpus } from "@software-land/search/corpus";

// @ts-expect-error dictionaryEntriesFromEquivalences is not a public corpus export
import { dictionaryEntriesFromEquivalences } from "@software-land/search/corpus";

// @ts-expect-error compileSynonyms is not a public corpus export
import { compileSynonyms } from "@software-land/search/corpus";

// @ts-expect-error SynonymArtifact is not a public corpus export
import type { SynonymArtifact } from "@software-land/search/corpus";

void compileCorpus;
void dictionaryEntriesFromEquivalences;
void compileSynonyms;
void (null as unknown as SynonymArtifact);

// @ts-expect-error configuredConceptsFromEquivalences is not a public corpus export
import { configuredConceptsFromEquivalences } from "@software-land/search/corpus";

// @ts-expect-error parseEquivalences is not a public corpus export
import { parseEquivalences } from "@software-land/search/corpus";

// @ts-expect-error EquivalenceArtifact is not a public corpus export
import type { EquivalenceArtifact } from "@software-land/search/corpus";

void configuredConceptsFromEquivalences;
void parseEquivalences;
void (null as unknown as EquivalenceArtifact);
