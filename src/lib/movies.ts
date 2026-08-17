import { formatVector, parseVector, query } from "./db";

export interface Movie {
  id: number;
  title: string;
  year: number | null;
  director: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  posterPath: string | null;
  popularity: number;
}

export interface ScoredMovie extends Movie {
  moodVector: number[];
}

interface MovieRow {
  id: number;
  title: string;
  year: number | null;
  director: string | null;
  genres: string[];
  runtime_minutes: number | null;
  poster_path: string | null;
  popularity: number;
  mood_vector?: string | null;
}

function toMovie(row: MovieRow): Movie {
  return {
    id: row.id,
    title: row.title,
    year: row.year,
    director: row.director,
    genres: row.genres ?? [],
    runtimeMinutes: row.runtime_minutes,
    posterPath: row.poster_path,
    popularity: row.popularity,
  };
}

function toScoredMovie(row: MovieRow): ScoredMovie {
  const moodVector = parseVector(row.mood_vector ?? null);
  if (!moodVector) throw new Error(`movie ${row.id} has no mood vector`);
  return { ...toMovie(row), moodVector };
}

const MOVIE_COLUMNS = `id, title, year, director, genres, runtime_minutes, poster_path, popularity`;

/**
 * The onboarding grid: the best-known films we have mood scores for.
 *
 * Popularity is the Wikidata sitelink count, which is a decent proxy for
 * "would a normal person recognise this" — the property the grid needs, since
 * a grid full of obscure films collects no signal.
 */
export async function getPopularMovies(limit = 60): Promise<Movie[]> {
  const rows = await query<MovieRow>(
    `SELECT ${MOVIE_COLUMNS}
       FROM movies
      WHERE mood_vector IS NOT NULL
      ORDER BY popularity DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map(toMovie);
}

/** Films the user has told us they have seen, with mood vectors for pairing. */
export async function getSeenMovies(userId: string): Promise<ScoredMovie[]> {
  const rows = await query<MovieRow>(
    `SELECT ${MOVIE_COLUMNS}, m.mood_vector
       FROM movies m
       JOIN seen_movies s ON s.movie_id = m.id
      WHERE s.user_id = $1
        AND s.seen
        AND m.mood_vector IS NOT NULL`,
    [userId],
  );
  return rows.map(toScoredMovie);
}

/**
 * Just the ids, for pre-selecting the onboarding grid. Lighter than
 * getSeenMovies, which loads mood vectors the grid has no use for.
 */
export async function getSeenMovieIds(userId: string): Promise<number[]> {
  const rows = await query<{ movie_id: number }>(
    `SELECT movie_id FROM seen_movies WHERE user_id = $1 AND seen`,
    [userId],
  );
  return rows.map((r) => r.movie_id);
}

/**
 * Applies an onboarding grid submission.
 *
 * Scoped deliberately to `shownIds` — the films the grid actually displayed.
 * A returning user's seen list can contain films discovered during earlier
 * sessions that the grid never showed, and unticking a poster must not quietly
 * erase those.
 */
export async function reconcileGridSelection(
  userId: string,
  shownIds: number[],
  selectedIds: number[],
): Promise<void> {
  const selected = new Set(selectedIds);
  const deselected = shownIds.filter((id) => !selected.has(id));

  await markSeen(userId, selectedIds, "grid", true);
  await markSeen(userId, deselected, "grid", false);
}

export async function markSeen(
  userId: string,
  movieIds: number[],
  source: "grid" | "skip" | "comparison",
  seen = true,
): Promise<void> {
  if (movieIds.length === 0) return;
  await query(
    `INSERT INTO seen_movies (user_id, movie_id, source, seen)
     SELECT $1, unnest($2::int[]), $3, $4
     ON CONFLICT (user_id, movie_id) DO UPDATE SET seen = EXCLUDED.seen`,
    [userId, movieIds, source, seen],
  );
}

/**
 * Top candidates for a fitted mood vector, excluding everything the user has
 * seen.
 *
 * `<#>` is pgvector's negative inner product, so ascending order gives the
 * highest w . v — exactly the Bradley-Terry utility. The HNSW index on
 * vector_ip_ops serves this directly.
 */
export async function getCandidates(
  userId: string,
  moodVector: number[],
  limit = 100,
): Promise<ScoredMovie[]> {
  const rows = await query<MovieRow>(
    `SELECT ${MOVIE_COLUMNS}, m.mood_vector
       FROM movies m
      WHERE m.mood_vector IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM seen_movies s
           WHERE s.user_id = $1 AND s.movie_id = m.id AND s.seen
        )
      ORDER BY m.mood_vector <#> $2::vector
      LIMIT $3`,
    [userId, formatVector(moodVector), limit],
  );
  return rows.map(toScoredMovie);
}

export async function getMoviesByIds(ids: number[]): Promise<Movie[]> {
  if (ids.length === 0) return [];
  const rows = await query<MovieRow>(
    `SELECT ${MOVIE_COLUMNS} FROM movies WHERE id = ANY($1::int[])`,
    [ids],
  );
  return rows.map(toMovie);
}

/** How many films are ready to be recommended. Used for the empty-state check. */
export async function getScoredMovieCount(): Promise<number> {
  const [row] = await query<{ count: string }>(
    `SELECT count(*) AS count FROM movies WHERE mood_vector IS NOT NULL`,
  );
  return Number(row.count);
}
