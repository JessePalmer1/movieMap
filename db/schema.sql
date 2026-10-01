-- movieMap schema
--
-- Mood vectors are stored as pgvector `vector(12)` rather than real[] so that
-- candidate retrieval can be a single indexed inner-product scan:
--   ORDER BY mood_vector <#> $1   -- <#> is negative inner product, so this
--                                 -- ranks by highest w . v
--
-- The dimension is pinned to the length of MOOD_AXES in src/lib/moodAxes.ts.
-- Changing that list invalidates every stored vector and needs a migration.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE movies (
    id              serial PRIMARY KEY,
    wikidata_id     text NOT NULL UNIQUE,          -- e.g. 'Q47703'
    imdb_id         text,                          -- 'tt0110912'
    tmdb_id         integer,                       -- posters only, never model input
    title           text NOT NULL,
    year            integer,
    runtime_minutes integer,
    director        text,
    genres          text[] NOT NULL DEFAULT '{}',

    -- Wikidata sitelink count: a CC0 proxy for how well known a film is.
    -- Drives the onboarding grid and gates the recommendation candidate pool.
    popularity      integer NOT NULL DEFAULT 0,

    -- TMDB poster path, resolved to an image URL at render time. TMDB's terms
    -- cap caching at six months, hence the timestamp.
    poster_path       text,
    poster_fetched_at timestamptz,

    -- US content rating (G / PG / PG-13 / R / NC-17) from Wikidata P1657.
    -- Nullable: roughly 75% coverage, thinner for older and non-US titles.
    content_rating            text,
    content_rating_fetched_at timestamptz,

    -- English Wikipedia article title; step 2 fetches the plot summary by it.
    article_title   text,
    plot_summary    text,                          -- Wikipedia, CC BY-SA
    plot_fetched_at timestamptz,

    -- Raw 0-10 LLM scores, kept so the corpus can be re-normalised without
    -- re-running the (expensive) scoring pass.
    mood_raw        real[],
    -- z-scored across the corpus; this is what the model actually uses.
    mood_vector     vector(12),

    embedding       vector(1024),                  -- optional, for similarity/dedup

    scored_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT movies_mood_raw_dim CHECK (mood_raw IS NULL OR array_length(mood_raw, 1) = 12)
);

CREATE INDEX movies_popularity_idx ON movies (popularity DESC);
CREATE INDEX movies_scored_idx ON movies (id) WHERE mood_vector IS NOT NULL;

-- Inner-product index for candidate retrieval. Unnecessary at 15k rows, but it
-- costs nothing to build and means scaling the catalogue needs no code change.
CREATE INDEX movies_mood_ip_idx ON movies
    USING hnsw (mood_vector vector_ip_ops);

-- Per-axis mean and standard deviation used to z-score mood_raw into
-- mood_vector. Kept so that a film scored after the fact can be placed on the
-- same scale without renormalising the whole corpus. Single row, id = 1.
CREATE TABLE mood_normalisation (
    id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    means       real[] NOT NULL,
    stds        real[] NOT NULL,
    corpus_size integer NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mood_normalisation_dims
        CHECK (array_length(means, 1) = 12 AND array_length(stds, 1) = 12)
);

-- ---------------------------------------------------------------------------
-- Users and what they have seen
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- Long-term taste, learned across sessions. Null until we have history;
    -- until then the fit shrinks toward zero. See FitOptions.prior.
    taste_vector vector(12)
);

CREATE TABLE seen_movies (
    user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    movie_id  integer NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    -- 'grid'       tapped during onboarding
    -- 'skip'       revealed by a "seen neither" during a session
    -- 'comparison' shown in a pair and chosen between
    source    text NOT NULL CHECK (source IN ('grid', 'skip', 'comparison')),
    seen      boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, movie_id)
);

CREATE INDEX seen_movies_user_idx ON seen_movies (user_id) WHERE seen;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'complete', 'abandoned')),
    -- The fitted mood vector, written when the session completes.
    mood_vector  vector(12),
    -- Which arm the session ran, so eval can compare them on real users.
    selection_strategy text NOT NULL DEFAULT 'active'
                 CHECK (selection_strategy IN ('active', 'random')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX sessions_user_idx ON sessions (user_id, created_at DESC);

-- Every comparison is training and evaluation data, and it is unrecoverable if
-- not captured. Store the timing too: a very fast answer is a confident one,
-- which is signal we may want later.
CREATE TABLE comparisons (
    id          bigserial PRIMARY KEY,
    session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    round       integer NOT NULL,
    movie_a_id  integer NOT NULL REFERENCES movies(id),
    movie_b_id  integer NOT NULL REFERENCES movies(id),
    -- Set only when outcome = 'chose'.
    winner_id   integer REFERENCES movies(id),
    -- pending  shown, awaiting an answer
    -- chose    the user picked one
    -- neither  the user has seen both and wants neither tonight; encoded as
    --          both films losing to a phantom average film at the origin
    outcome     text NOT NULL DEFAULT 'pending',
    -- Expected information gain of this pair at the time it was chosen.
    eig         real,
    shown_at    timestamptz NOT NULL DEFAULT now(),
    answered_at timestamptz,

    UNIQUE (session_id, round),
    CONSTRAINT comparisons_distinct_films CHECK (movie_a_id <> movie_b_id),
    CONSTRAINT comparisons_winner_is_shown
        CHECK (winner_id IS NULL OR winner_id IN (movie_a_id, movie_b_id)),
    CONSTRAINT comparisons_outcome_valid
        CHECK (outcome IN ('pending', 'chose', 'neither')),
    CONSTRAINT comparisons_chose_has_winner
        CHECK (outcome <> 'chose' OR winner_id IS NOT NULL),
    CONSTRAINT comparisons_unchosen_has_no_winner
        CHECK (outcome = 'chose' OR winner_id IS NULL)
);

CREATE INDEX comparisons_session_idx ON comparisons (session_id, round);
CREATE INDEX comparisons_outcome_idx ON comparisons (session_id, outcome);

-- ---------------------------------------------------------------------------
-- Output
-- ---------------------------------------------------------------------------

CREATE TABLE recommendations (
    id          bigserial PRIMARY KEY,
    session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    movie_id    integer NOT NULL REFERENCES movies(id),
    rank        integer NOT NULL,
    -- Raw w . v before any reranking, kept so we can measure how much the
    -- LLM rerank actually moved things.
    score       real NOT NULL,
    reranked    boolean NOT NULL DEFAULT false,
    rationale   text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, rank)
);

CREATE TABLE feedback (
    id                 bigserial PRIMARY KEY,
    recommendation_id  bigint NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
    watched            boolean,
    -- -1 / 0 / +1
    thumbs             integer CHECK (thumbs IN (-1, 0, 1)),
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (recommendation_id)
);
