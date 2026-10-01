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

**"Neither appeals right now" carries magnitude.** Pairwise comparison is *scale-free* — it recovers the direction of a mood but never its size. A rejected pair is the one signal that fixes that: mood vectors are z-scored, so the origin is literally the average film, and "neither of these tonight" means *both score below average for me right now*. It is recorded as two comparisons lost against a phantom film at the origin — no new machinery, just two extra rows in the same fit.

Simulated over 500 users at 10 rounds, with users who reject a pair when neither film clears their bar:

```
  reject-rate  design     neithers  cos    top-1    top-3
  0.0          control    0.0       0.684  0.967    0.993
  0.4          control    0.0       0.686  0.965    0.991
  0.4          lost       1.2       0.676  0.960    0.989
  0.4          baseline   1.1       0.751  0.979    0.995
```

`control` forces a choice, `lost` discards the answer, `baseline` is the encoding above. Note the middle row: **offering the button and then ignoring the answer is worse than not offering it at all.** The gain is entirely in the encoding.

Two guards, because it is also the cheapest button to press and a bored user pressing it asserts something false: capped at `MAX_NEITHER_PER_SESSION = 3`, and rendered as a quiet text link rather than a third button of equal weight. A rejection also steers the next question — information gain alone would happily offer another pair from the same neighbourhood, so `avoidCenters` penalises pairs near a rejected midpoint.

**The final five are chosen for variety, not just score.** Taking the top N by score alone returns near-duplicates, because films scoring well on one mood direction cluster together — observed for real, with two Gaidai comedies in one result and two Tarkovsky films in another. Selection is therefore maximal marginal relevance: take the best film, then keep taking the best film *not already represented*, where "represented" means the same director, the same series, or a mood vector too close to something already picked.

Series detection compares leading title *words*, not characters, because character prefixes merge unrelated films — "The Terminator" and "The Terminal" share ten leading characters but only the word "the". Words also catch the case that defeats everything simpler: *The SpongeBob Movie: Sponge Out of Water* and *The SpongeBob SquarePants Movie* have different directors and put their colons in different places.

**Explanations are computed, not written.** Each pick reports which mood axes contributed most to its score — literally the largest terms of the dot product — so a recommendation arrives as "because you wanted something light and funny". This is the payoff of fitting over interpretable axes rather than a raw embedding, and it needs no model.

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
| `light` | fast, funny, light | Kidnapping, Caucasian Style · Operation Y · La Grande Vadrouille |
| `heavy` | high attention cost, challenging, serious | The Zone of Interest · Eraserhead · The Mirror |
| `cosy` | warm, calm, nostalgic | Singin' in the Rain · The Sound of Music · Miracle on 34th Street |
| `arty` | slow, challenging, grounded | The Mirror · Nostalghia · Death in Venice |
| `tense` | fast, plot-driven, tense | 2012 · World War Z · Mission: Impossible – Fallout |

Five moods, five sets with no overlap between them. At 503 films *Stalker* and *Solaris*
answered both `heavy` and `arty`, because nothing else in the catalogue was that slow;
at 2000 those two moods separate cleanly.

---

## Running it

```bash
cp .env.example .env.local     # DATABASE_URL is already correct for docker
npm install
npm run db:up                  # Postgres 17 + pgvector on port 5433
npm run db:migrate             # apply anything in db/migrations
npm run dev
```

The catalogue is already scored and committed (`data/mood-scores/`), so after `db:up` you need the pipeline once to populate the database:

```bash
npm run data:films -- --limit 2000   # Wikidata: titles, years, directors, genres
npm run data:plots                   # Wikipedia plot summaries
npm run data:load-scores             # the committed mood scores
npm run data:normalize               # z-score across the corpus
npm run data:ratings                 # Wikidata P1657: G / PG / PG-13 / R
```

### Optional

```bash
npm run data:posters    # needs TMDB_API_KEY; without it, typographic poster cards
npm run data:embed      # needs VOYAGE_API_KEY; not used by the recommender
npm run data:moods      # needs ANTHROPIC_API_KEY; regenerate scores from scratch
```

### No model at runtime

Serving a session touches no LLM at all. Fitting, retrieval, diversity selection and the explanations are all deterministic — the same session always produces the same five films. `ANTHROPIC_API_KEY` is used by `data:moods` if you ever want to regenerate the mood scores from scratch, and by nothing else.

---

## Where the data comes from

Licensing constrained the architecture, so it is worth stating plainly.

| Source | Licence | Used for |
|---|---|---|
| [Wikidata](https://www.wikidata.org) | CC0 | Titles, years, directors, genres, runtimes, ID crosswalks, popularity (sitelink count), US content rating (P1657) |
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
  session.ts        the loop: fit, select, retrieve, store
  selection.ts      diversity selection + computed explanations
scripts/
  01..06            the offline pipeline, each resumable
  load-mood-scores  loads data/mood-scores/*.tsv
  calibrate         simulated users: lambda and rounds
  eval              leave-one-out on real sessions
  smoke-session     end-to-end through the HTTP API
db/schema.sql       everything, with the reasoning in comments
```

## Not done yet

- **Accounts.** Your seen list already persists — an anonymous `users` row keyed by an httpOnly cookie, with `seen_movies` in Postgres — so returning to the same browser skips onboarding. What no account means is that the list does not follow you to a second device and does not survive clearing cookies. Adding real auth later needs no migration of what exists: `users.id` is already the anchor, so an `email` or `oauth_subject` column would attach an identity to the row a visitor already has, rather than starting them over.
- **Long-term taste vector.** The schema has `users.taste_vector` and the fit already accepts a prior; it is zero until there are returning users to learn from.
- **Anglophone skew is missing.** Popularity is the Wikidata sitelink count, which measures *global* fame rather than English-language fame. It works, but it surfaces films that are canonical elsewhere and unknown to most English speakers: the `light` smoke test returns three Soviet and French comedies, all correctly scored as light and fast, none of which a typical US viewer would recognise. Since the whole design depends on comparing films the user has *seen*, that matters. Wikidata exposes original language (P364) and English Wikipedia pageviews are available separately — either could weight the onboarding grid without touching the mood model.
- **Bigger catalogue.** 2000 films separates the moods cleanly. `data:films` scales to ~15k by raising `--limit` and lowering `--min-sitelinks`; the binding constraint is scoring, not fetching.
- **Trakt import** for the seen list. Letterboxd's API is request-only.
- **Feedback capture.** The `feedback` table exists and nothing writes to it.
