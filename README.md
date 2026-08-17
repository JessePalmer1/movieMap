# movieMap

Find something to watch based on the mood you are in right now, not the taste you have in general.

You tap through ten forced choices between films you have **already seen** — not which is better, which you would rather watch tonight — and it recommends three you have not seen that match the mood behind those picks.

---

## Why it works this way

**Comparisons, not ratings.** People cannot describe their own mood accurately ("something light but not stupid, slow but not boring"), but everyone can answer *which of these two, right now?* This is Thurstone's Law of Comparative Judgment, and Flickchart has run the same interaction at scale for over a decade.

**Only films you have seen.** This is the load-bearing constraint. Comparing films the user already knows holds *taste* constant — they know both are good — so the variance in what they pick is much closer to pure mood. Comparing unseen films would measure poster appeal and marketing instead.

**Differences, not averages.** The single most important implementation detail. If someone picks *Heat* over *Amélie* and then *Amélie* over *Schindler's List*, the centroid of the chosen films points nowhere meaningful. The signal is in the *differences*, so preferences are fitted with a Bradley–Terry model:

```
P(i beats j) = sigmoid( w · (v_i − v_j) )
```

fitted by ridge-regularised logistic regression on winner-minus-loser vectors. Structurally identical to an RLHF reward model. See `src/lib/preference.ts`.

**Twelve interpretable axes, not a text embedding.** Ten comparisons cannot fit a 768-dimensional weight vector — that is 768 parameters from ten bits. They can fit a 12-dimensional one. Every film is scored 0–10 on axes like light↔heavy, slow↔propulsive, comforting↔demanding (`src/lib/moodAxes.ts`), which also makes the result explainable: *"tonight you are after something light, funny, low attention cost."*

**No graph database.** A weighted film-relationship graph requires inventing the edge weights, which is the entire hard problem — and you would invent them from the same features that go into a vector anyway. kNN over mood vectors *is* that graph, with derived weights. At 500 films pgvector's inner-product scan is instant.

---

## Does it actually work?

Two scripts answer this, and they are the point of the project rather than an afterthought.

### `npm run calibrate` — simulated users

Users whose choices follow Bradley–Terry exactly, so these are an upper bound.

```
PART 2 - random vs active (BALD) pair selection
  rounds   random cos   active cos   lift
  8        0.569        0.624        +0.055
  12       0.647        0.736        +0.089
  16       0.720        0.816        +0.096

PART 3 - recommendation quality (active selection)
  rounds   top-1 pctile   top-3 best pctile   hit@1%
  8        0.953          0.987               0.780
  10       0.968          0.994               0.850
  12       0.979          0.997               0.917
```

Two findings shaped the build:

1. **Ranking is far more forgiving than parameter recovery.** At ten comparisons the fitted weight vector only correlates ~0.68 with the truth — but the best of the top three recommendations still lands at the **99.4th percentile** of that user's true preference ordering. You do not need to know the mood precisely; you need the dominant axes right.
2. **Active pair selection is not optional.** BALD-selected pairs at 12 rounds match random pairs at 16 — roughly a 30% saving in taps, matching the literature.

Hence `TOTAL_ROUNDS = 10`: past 12 the curve flattens while the tap count keeps growing.

### `npm run eval` — real users

Leave-one-out on stored sessions, comparing per-session fitting against a **single global weight vector fitted across every session** — a model with no notion of "tonight". If session fitting does not clearly beat it, the mood premise is not carrying its weight. This needs a few dozen real sessions to say anything.

### `npm run smoke -- --strategy light` — end-to-end

Drives a full session through the real HTTP API with a simulated user who answers by a known rule, so the output is falsifiable:

| strategy | fitted mood | recommended |
|---|---|---|
| `light` | funny, low attention cost, comforting | Minions: The Rise of Gru · Minions · Mamma Mia! |
| `heavy` | serious, slow and contemplative, heavy | Stalker · Solaris · The Passion of the Christ |
| `cosy` | warm, hopeful, calm | Mary Poppins · Singin' in the Rain · The Three Caballeros |
| `arty` | slow, vibe-driven, challenging | Solaris · Stalker · Mulholland Drive |

---

## Running it

```bash
cp .env.example .env.local     # DATABASE_URL is already correct for docker
npm install
npm run db:up                  # Postgres 17 + pgvector on port 5433
npm run dev
```

The catalogue is already scored and committed (`data/mood-scores/`), so after `db:up` you need the pipeline once to populate the database:

```bash
npm run data:films -- --limit 500    # Wikidata: titles, years, directors, genres
npm run data:plots                   # Wikipedia plot summaries
npm run data:load-scores             # the committed mood scores
npm run data:normalize               # z-score across the corpus
```

### Optional

```bash
npm run data:posters    # needs TMDB_API_KEY; without it, typographic poster cards
npm run data:embed      # needs VOYAGE_API_KEY; not used by the recommender
npm run data:moods      # needs ANTHROPIC_API_KEY; regenerate scores from scratch
```

### Rationale text

The three recommendations can carry a one-sentence explanation, written by an LLM that sees the chosen/rejected pairs and catches interaction effects a linear model cannot express ("comedies, but only melancholy ones"). This needs `ANTHROPIC_API_KEY`. **Without it the app degrades gracefully** to the top three by mood score with no rationale — which is what it currently does. Everything else is unaffected.

---

## Where the data comes from

Licensing constrained the architecture, so it is worth stating plainly.

| Source | Licence | Used for |
|---|---|---|
| [Wikidata](https://www.wikidata.org) | CC0 | Titles, years, directors, genres, runtimes, ID crosswalks, popularity (sitelink count) |
| [Wikipedia](https://en.wikipedia.org) | CC BY-SA | Plot summaries — the text the mood scorer reads |
| `data/mood-scores/` | ours | Derived from the CC-licensed text above |
| TMDB | non-commercial + attribution | **Poster images only, at display time** |

TMDB's API terms prohibit use "in connection with, including for training, a machine learning (ML) or artificial intelligence (AI) based Application", prohibit derivatives, and cap caching at six months. Embedding TMDB overviews into a vector store sits squarely inside that, which is why nothing TMDB returns is ever fed to the scorer, the embedder or the recommender. IMDb's non-commercial datasets forbid republishing as any online database; MovieLens is research-only. Building the mood scores from CC-licensed text means no one's terms of service can break this app later.

Attribution is rendered in the site footer, as their terms require.

---

## Layout

```
src/lib/
  moodAxes.ts       the 12 axes — single source of truth
  preference.ts     Bradley-Terry ridge fit + Laplace covariance
  pairSelection.ts  BALD acquisition — which pair teaches us most
  linalg.ts         12x12 dense linear algebra, no dependencies
  movies.ts         catalogue queries, pgvector retrieval
  session.ts        the loop: fit, select, retrieve, rerank, store
  rerank.ts         LLM shortlist + rationale (optional)
scripts/
  01..06            the offline pipeline, each resumable
  load-mood-scores  loads data/mood-scores/*.tsv
  calibrate         simulated users: lambda and rounds
  eval              leave-one-out on real sessions
  smoke-session     end-to-end through the HTTP API
db/schema.sql       everything, with the reasoning in comments
```

## Not done yet

- **Long-term taste vector.** The schema has `users.taste_vector` and the fit already accepts a prior; it is zero until there are returning users to learn from.
- **Bigger catalogue.** 503 films is enough to prove the mechanism but thin at the extremes — *Stalker* and *Solaris* show up for several distinct moods because little else is that slow. `data:films` scales to ~15k by dropping `--limit`.
- **Trakt import** for the seen list. Letterboxd's API is request-only.
- **Feedback capture.** The `feedback` table exists and nothing writes to it.
