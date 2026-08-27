import { compileCorpus } from "@software-land/search/corpus";

// @ts-expect-error dictionaryEntriesFromEquivalences is not a public corpus export
import { dictionaryEntriesFromEquivalences } from "@software-land/search/corpus";

void compileCorpus;
void dictionaryEntriesFromEquivalences;
