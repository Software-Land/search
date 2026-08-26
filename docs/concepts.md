# Concepts

The search runtime splits **query understanding**, **candidate retrieval**, **ranking**, and **relatedness**.

```text
query
  → analysis (tokens, lemmas, configured equivalences, typo alternatives)
  → retriever (indexed default; full-scan | adaptive explicit)
  → relationship expansion
  → named features + constraints
  → deterministic ranking on candidate set C
  → results (+ optional related rail)
```

Exact indexed retrieval enumerates every legitimate posting match. After relationship expansion it retains a sufficient per-signature prefix for the final ranker; `candidateLimit` is not a retrieval bound on this path. Builtin ranking is sparse in the constraint-signature count B; worst case remains Θ(C²) when B = C.

## Equivalence ≠ relatedness ≠ generated evidence

| | Lives where | Means |
| --- | --- | --- |
| Concept map (`dictionary({ entries: [{ key, aliases }] })`) | what query forms mean the **same thing** | `aliases[0]` is the canonical lexical sequence (compiled internally as expansion). Later aliases are alternate same-intent forms. |
| Relationship map (`relationshipMap`) | what other forms/concepts/documents are explicitly **related** | kinds `equivalent` (existing synonym recall) and `related` (standalone / topical / editorial). Directional. No auto-reverse. No authored numeric weight. |
| Semantic graph (generated MiniLM artifact) | what relationships the **model inferred** | separate generated pipeline with embedding provenance. Not authored in `relationshipMap`. |

`equivalent` is not `related`. Generated is not authored.

Core does not invent aliases. `wifi` will not match `Wi-Fi` unless you compile that decision. Lemma generators stay in the site build; Core consumes an optional `Record<string, string>` and will not import spaCy, lemminflect, or a site lemmatizer.

Former authoring fields `expansion`, `primary`, `standaloneRecall`, and `topicalRecall` are not part of the public configured-concept schema. Explain output may still name compiled standalone/topical provenance. Use `migrateConfiguredEntry()` for a one-shot conversion from 0.4 / early-0.5 rows.

## What is frozen

Ranking features, constraints, query analysis, relationship expansion policy, and the retriever contract are frozen. Changing them is a new version of search, not a silent ranking tweak.

## What is not “AI search”

Optional `search-semantic` (shipped in the npm package, launched from Node as `@software-land/search/semantic`) may use embeddings **offline** to propose relationship edges. Runtime search does not load a model, a vector database, or query embeddings.
