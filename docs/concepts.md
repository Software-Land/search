# Concepts

The search runtime splits **query understanding**, **candidate retrieval**, **ranking**, and **relatedness**.

```text
query
  → analysis (tokens, lemmas, configured concepts, typo alternatives)
  → retriever (indexed default; full-scan | adaptive explicit)
  → ranking-state materialization (packed views on eligible ordinary search(); FeatureVector on diagnostic/fallback)
  → relationship expansion
  → named features + constraints (same ranking semantics)
  → deterministic ranking on candidate set C
  → results (+ optional related rail)
```

Exact indexed retrieval enumerates every legitimate posting match. After relationship expansion it retains a sufficient per-signature prefix for the final ranker; `candidateLimit` is not a retrieval bound on this path. Builtin ranking is sparse in the constraint-signature count B; worst case remains Θ(C²) when B = C.

## Equivalence ≠ relatedness ≠ generated evidence

Search data is four distinct layers:

| Name | Meaning |
| --- | --- |
| Configured concepts (`configuredConcepts`) | authored `{ key, aliases }` rows. Not the corpus vocabulary. |
| Lexical index (`lexicalIndex`) | corpus lexical term/posting index |
| Relationship map (`relationshipMap`) | authored form/concept/document relevance (`equivalent` / `related`) |
| Document relationships (`documentRelationships`) | compiled document-to-document `RelationshipArtifact` |

| | Lives where | Means |
| --- | --- | --- |
| Concept map (`configuredConcepts`: `{ key, aliases }`) | what query forms mean the **same thing** | Aliases are unordered semantic peers. `key` is the concept identifier and lexical key form. Unambiguous key/alias spellings share ranked results. Compile with `compileAuthoredRelevance()`. |
| Relationship map (`relationshipMap`) | what other forms/concepts/documents are explicitly **related** | kinds `equivalent` (one-hop recall) and `related` (standalone / topical / editorial). Directional. No auto-reverse. No authored numeric weight. Compile with `compileAuthoredRelevance()`. |
| Semantic graph (generated MiniLM artifact) | what relationships the **model inferred** | separate generated pipeline with embedding provenance. Not authored in `relationshipMap`. |

`equivalent` is not `related`. Generated is not authored. Browser `SearchClient.init({ configuredConcepts, relationshipMap, documentRelationships })` uses these same primitives.

### Configured occupancy and ranking

A concept is authored as `key` + `aliases`. Aliases are unordered semantic peers; alias array order has no search semantic effect. `key` remains the concept identifier and lexical key form. Every alias identifies the **same** configured intent; aliases are not loose recall hints.

Once occupancy is unambiguous, key and alias spellings have identical search semantics and ranked results. Typed surface stays on the query for explain/provenance and must not leak into ranking. Occupied ranking evaluates each peer form independently; it does not concatenate aliases into one lexical query.

A unique configured-form prefix that is not strong enough to occupy still has configured evidence. Occupancy and weak configured-prefix recall are distinct:

| State | Query interpretation | Retrieval | Ranking |
| --- | --- | --- | --- |
| Occupancy | the query means concept C | concept key plus peer forms | occupied configured ranking |
| Configured-prefix recall | weaker evidence that C should contribute | keep ordinary lexical forms; add **C's key only** | numeric `configuredPrefixRecallScore` on prefix-only key candidates |

Occupancy subsumes prefix recall. Weak recall does not set `configuredSequenceIntent`, attach a `configured-concept` to `query.concepts`, change `configuredFormCoverage`, or spray peer aliases.

Graded unoccupied evidence for a uniquely resolved form prefix is:

```text
partialCompleteness = last token is a character prefix
  ? typedNormalized.length / wantedNormalized.length
  : 0
evidence = (exactCount + partialCompleteness) / matchedForm.length
```

`1/N` is nonzero. There is no hard minimum coverage cutoff for recall. Occupancy is the strong state where enough of the form is present that replacing ordinary lexical interpretation is justified: a unique exact left prefix occupies at coverage ≥ 1/2 (`national institute` 2/4), while 2/6 stays graded recall. Character-prefix final tokens keep the older 2/3 floor. Occupancy coverage counts content tokens only. A stop cannot supply the content that crosses the occupancy threshold (`identity and` is recall, not IAM occupancy). Skipped trailing structural tokens, including proper prefixes of skippable stops, do not undo occupancy already earned by preceding content (`national institute`, `national institute o`, and `national institute of` all occupy NIST). Arbitrary one-character tokens that are not stop prefixes (`national institute x`) stay ordinary content.

One-token queries fail closed when the exact first token belongs to forms from more than one concept (`hypertext`, `real`, `software`). A unique one-token proper prefix of the first form token is graded recall, never occupancy: `nationa` is weaker NIST recall than exact `national`. A proper prefix that matches several concepts (`appl` → API and AppSec) still does not occupy and still has no unique `configuredPrefixRecall`. Retrieval may keep every matching key as weak key-only evidence so the query does not fall through to untyped body-prefix spray. Leading wrapper stops are skipped for prefix recall only (`what is an appl` is the same first-token prefix as `appl`). Configured *key* prefixes remain a separate occupancy path. For two or more aligned tokens, each concept keeps its strongest matching form; only a unique winning concept contributes; ties fail closed. Same-concept multiple forms keep the **maximum** valid evidence; adding a longer authored form must not reduce a shorter matching form.

The optional complete-interpretation collector does not treat an ambiguous one-content-token prefix as a complete body-phrase interpretation. Independently retrieved configured-prefix-recall keys stay, including title-key identity (`key-in-title`) and relationship neighbors of those primaries. A single typed token may also keep ordinary title-prefix hits.

Packed ranking evidence fails closed for this query class (`configured-prefix-recall`) and uses the existing FeatureVector path. Prefix-only candidates keep the `directClass` they would otherwise have; the new score applies only when that class is `none` and is not a discrete ranking-signature change.

Configured-content identity is not occupancy. When identity uniquely names a complete configured concept behind structural wrappers, ranking may accept an authored peer-form title for that concept (unioned with literal original-surface title equality). Occupancy resolution, collector apply/decline, typed phrase evidence, and occupancy's looser peer-form prefix reduction stay unchanged. Structural wrappers do not count as concept coverage.

Occupancy is not matched-form completeness. A unique prefix may occupy a concept while query `formCoverage` remains the true prefix coverage (`application programming` is 2/3 of `application programming interface`). An unused extra alias must not dilute an existing form match.

A non-occupied configured prefix may still appear in query analysis (`configuredPrefixSpans`, concept `formCoverage`) without becoming candidate evidence. Candidate `configuredFormCoverage` is 0 unless the query uniquely occupies.

- Exact configured-key identity outranks a conflicting foreign one-token alias of that same typed form. Two distinct exact keys still fail closed.
- One-token aliases occupy only on exact typed identity.
- Multi-token configured forms may complete an incomplete final token when preceding context uniquely identifies the concept.
- Incomplete guessing of a configured *key* remains subject to the short-prefix information bound (`form.length < 3`). Exact keys occupy regardless of key length.

Core does not invent aliases. `wifi` will not match `Wi-Fi` unless you compile that decision. Lemma generators stay in the site build; Core consumes an optional `Record<string, string>` and will not import spaCy, lemminflect, or a site lemmatizer.

Former authoring fields `expansion`, `primary`, `standaloneRecall`, and `topicalRecall` are not part of the public configured-concept schema. Explain output may still name compiled standalone/topical provenance. Use `migrateConfiguredEntry()` for a one-shot conversion from 0.4 / early-0.5 rows.

## What is frozen

Ranking features, constraints, query analysis, relationship expansion policy, and the retriever contract are frozen. Changing them is a new version of search, not a silent ranking tweak.

## What is not “AI search”

Optional `search-semantic` (shipped in the npm package, launched from Node as `@software-land/search/semantic`) may use embeddings **offline** to propose relationship edges. Runtime search does not load a model, a vector database, or query embeddings.
