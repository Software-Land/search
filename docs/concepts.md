# Concepts

The search runtime splits **query understanding**, **candidate retrieval**, **ranking**, and **relatedness**.

```text
query
  → analysis (tokens, lemmas, configured concepts, typo alternatives)
  → retriever (indexed default; full-scan | adaptive explicit)
  → relationship expansion
  → named features + constraints
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
