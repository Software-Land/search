# Concepts

The search runtime splits **query understanding**, **candidate retrieval**, **ranking**, and **relatedness**.

```text
query
  → analysis (tokens, lemmas, configured equivalences, typo alternatives)
  → retriever (full-scan | indexed | adaptive)
  → named features + constraints
  → deterministic ranking
  → results (+ optional related rail)
```

## Equivalence ≠ synonym ≠ relatedness

| | Lives where | Affects |
| --- | --- | --- |
| Equivalence (`tls` ↔ transport layer security) | dictionary / equivalences artifact | query interpretation |
| Near-synonym | synonyms artifact | query interpretation |
| Morphology (site lemma table) | `morphology({ lemmas })` / Worker `englishOptions` | query and document analysis |
| Related documents (Bluetooth → Connected devices) | relationships artifact | expansion after strong primaries |

Core does not invent aliases. `wifi` will not match `Wi-Fi` unless you compile that decision. Lemma generators stay in the site build; Core consumes an optional `Record<string, string>` and will not import spaCy, lemminflect, or a site lemmatizer.

## What is frozen

Ranking features, constraints, query analysis, relationship expansion policy, and the retriever contract are frozen. Changing them is a new version of search, not a silent ranking tweak.

## What is not “AI search”

Optional `search-semantic` (shipped in the npm package, launched from Node as `@software-land/search/semantic`) may use embeddings **offline** to propose relationship edges. Runtime search does not load a model, a vector database, or query embeddings.
