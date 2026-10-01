import { formatVector, parseVector, query } from "./db";
import { identity } from "./linalg";
import { MOOD_DIM, describeMood } from "./moodAxes";
import { Comparison, fitMoodVector } from "./preference";
import { selectNextPair } from "./pairSelection";
import { Movie, ScoredMovie, getCandidates, getSeenMovies, markSeen, toMovie } from "./movies";
import { selectRecommendations } from "./selection";

/**
 * How many comparisons a session asks for.
 *
 * From scripts/calibrate.ts, with active selection over 12 axes: at 8 rounds
 * the best of the top three recommendations lands at the 98.7th percentile of
 * the user's true preference ordering, and at 10 rounds the 99.4th. Past 12
 * the curve flattens while the tap count keeps growing, so 10 is the knee.
 */
export const TOTAL_ROUNDS = 10;

/** Ridge strength for the session fit. See the lambda sweep in calibrate.ts. */
const LAMBDA = 1.0;

/** Films retrieved by mood score before diversity selection thins them. */
const CANDIDATE_POOL = 150;

export const RECOMMENDATION_COUNT = 5;

/** Below this many seen films, pair selection has nothing to work with. */
export const MIN_SEEN_MOVIES = 8;

/**
 * How many times a session may answer "neither".
 *
 * Each one is genuinely informative, but it is also the cheapest button to
 * press, and a user pressing it out of indecision injects a false "both below
 * average" claim — worse than no answer at all. Capping it keeps the escape
 * hatch available to people who mean it without letting it become the path of
 * least resistance through the whole session.
 */
export const MAX_NEITHER_PER_SESSION = 3;

export interface PairPrompt {
  round: number;
  totalRounds: number;
  a: Movie;
  b: Movie;
  /** "Neither" answers still allowed; the UI hides the option at zero. */
  neitherRemaining: number;
}

export interface SessionRecommendation {
  movie: Movie;
  rank: number;
  /** Mood axes this film matched on, strongest first. Computed, not written. */
  reasons: string[];
}

export interface SessionResult {
  moodWords: string[];
  recommendations: SessionRecommendation[];
}

// ---------------------------------------------------------------------------
// Users and sessions
// ---------------------------------------------------------------------------

export async function createUser(): Promise<string> {
  const [row] = await query<{ id: string }>(`INSERT INTO users DEFAULT VALUES RETURNING id`);
  return row.id;
}

export async function userExists(userId: string): Promise<boolean> {
  const rows = await query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
  return rows.length > 0;
}

export async function createSession(userId: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO sessions (user_id) VALUES ($1) RETURNING id`,
    [userId],
  );
  return row.id;
}

async function getSessionOwner(sessionId: string): Promise<string | null> {
  const rows = await query<{ user_id: string }>(`SELECT user_id FROM sessions WHERE id = $1`, [
    sessionId,
  ]);
  return rows[0]?.user_id ?? null;
}

/** Throws unless the session exists and belongs to this user. */
async function assertOwnership(sessionId: string, userId: string): Promise<void> {
  const owner = await getSessionOwner(sessionId);
  if (owner === null) throw new Error("session not found");
  if (owner !== userId) throw new Error("session belongs to a different user");
}

// ---------------------------------------------------------------------------
// Fitting the current mood
// ---------------------------------------------------------------------------

interface AnsweredRow {
  winner_vector: string;
  loser_vector: string;
}

interface NeitherRow {
  a_vector: string;
  b_vector: string;
}

/**
 * Every answered comparison in the session, expressed as mood differences.
 *
 * A 'neither' answer contributes two rows rather than none. Mood vectors are
 * z-scored, so the origin is the average film, and "neither of these appeals
 * tonight" reads as "both score below average for me right now". That is the
 * only signal in the whole design that says anything about *magnitude* —
 * Bradley-Terry over pairs is scale-free and can otherwise recover a direction
 * but never a distance.
 *
 * Simulated over 500 users at 10 rounds, encoding it this way lifts direction
 * recovery from 0.686 to 0.751 and top-1 percentile from 0.965 to 0.979,
 * whereas discarding the answer scores *below* forcing a choice (0.676).
 * See the note in scripts/calibrate.ts.
 */
async function getAnsweredComparisons(sessionId: string): Promise<Comparison[]> {
  const [chosen, neither] = await Promise.all([
    query<AnsweredRow>(
      `SELECT wm.mood_vector AS winner_vector,
              lm.mood_vector AS loser_vector
         FROM comparisons c
         JOIN movies wm ON wm.id = c.winner_id
         JOIN movies lm ON lm.id = CASE WHEN c.winner_id = c.movie_a_id
                                        THEN c.movie_b_id ELSE c.movie_a_id END
        WHERE c.session_id = $1 AND c.outcome = 'chose'
        ORDER BY c.round`,
      [sessionId],
    ),
    query<NeitherRow>(
      `SELECT am.mood_vector AS a_vector, bm.mood_vector AS b_vector
         FROM comparisons c
         JOIN movies am ON am.id = c.movie_a_id
         JOIN movies bm ON bm.id = c.movie_b_id
        WHERE c.session_id = $1 AND c.outcome = 'neither'
        ORDER BY c.round`,
      [sessionId],
    ),
  ]);

  const comparisons: Comparison[] = chosen.map((row) => ({
    winner: parseVector(row.winner_vector)!,
    loser: parseVector(row.loser_vector)!,
  }));

  const averageFilm = new Array(MOOD_DIM).fill(0);
  for (const row of neither) {
    comparisons.push({ winner: averageFilm, loser: parseVector(row.a_vector)! });
    comparisons.push({ winner: averageFilm, loser: parseVector(row.b_vector)! });
  }

  return comparisons;
}

/** Midpoints of the pairs this session rejected outright, in mood space. */
async function getRejectedMidpoints(sessionId: string): Promise<number[][]> {
  const rows = await query<NeitherRow>(
    `SELECT am.mood_vector AS a_vector, bm.mood_vector AS b_vector
       FROM comparisons c
       JOIN movies am ON am.id = c.movie_a_id
       JOIN movies bm ON bm.id = c.movie_b_id
      WHERE c.session_id = $1 AND c.outcome = 'neither'`,
    [sessionId],
  );
  return rows.map((row) => {
    const a = parseVector(row.a_vector)!;
    const b = parseVector(row.b_vector)!;
    return a.map((x, i) => (x + b[i]) / 2);
  });
}

async function countNeither(sessionId: string): Promise<number> {
  const [row] = await query<{ count: string }>(
    `SELECT count(*) AS count FROM comparisons WHERE session_id = $1 AND outcome = 'neither'`,
    [sessionId],
  );
  return Number(row.count);
}

/** The user's long-term taste, if we have it; otherwise no prior preference. */
async function getPrior(userId: string): Promise<number[]> {
  const rows = await query<{ taste_vector: string | null }>(
    `SELECT taste_vector FROM users WHERE id = $1`,
    [userId],
  );
  return parseVector(rows[0]?.taste_vector ?? null) ?? new Array(MOOD_DIM).fill(0);
}

async function fitSession(sessionId: string, userId: string) {
  const [comparisons, prior] = await Promise.all([
    getAnsweredComparisons(sessionId),
    getPrior(userId),
  ]);
  return fitMoodVector(comparisons, { lambda: LAMBDA, prior });
}

// ---------------------------------------------------------------------------
// The comparison loop
// ---------------------------------------------------------------------------

/**
 * Returns the pair to show next, or null when the session has collected all
 * its comparisons.
 *
 * An unanswered comparison for the current round is returned as-is rather than
 * redrawn, so a refresh does not silently discard a question.
 */
export async function getNextPair(
  sessionId: string,
  userId: string,
): Promise<PairPrompt | null> {
  await assertOwnership(sessionId, userId);

  const pending = await query<{
    round: number;
    movie_a_id: number;
    movie_b_id: number;
  }>(
    `SELECT round, movie_a_id, movie_b_id
       FROM comparisons
      WHERE session_id = $1 AND outcome = 'pending'
      ORDER BY round
      LIMIT 1`,
    [sessionId],
  );

  const seen = await getSeenMovies(userId);
  const byId = new Map(seen.map((m) => [m.id, m]));

  if (pending.length > 0) {
    const a = byId.get(pending[0].movie_a_id);
    const b = byId.get(pending[0].movie_b_id);
    // Both are still in the seen pool: hand the same question back.
    if (a && b) {
      return {
        round: pending[0].round,
        totalRounds: TOTAL_ROUNDS,
        a,
        b,
        neitherRemaining: MAX_NEITHER_PER_SESSION - (await countNeither(sessionId)),
      };
    }
    // One was marked unseen since; drop the question and draw a fresh one.
    await query(`DELETE FROM comparisons WHERE session_id = $1 AND round = $2`, [
      sessionId,
      pending[0].round,
    ]);
  }

  // Both 'chose' and 'neither' consume a round; only 'pending' does not.
  const [{ count }] = await query<{ count: string }>(
    `SELECT count(*) AS count FROM comparisons
      WHERE session_id = $1 AND outcome <> 'pending'`,
    [sessionId],
  );
  const answered = Number(count);
  if (answered >= TOTAL_ROUNDS) return null;

  if (seen.length < 2) return null;

  const shownCounts = await getShownCounts(sessionId);
  const { w, covariance } = await fitSession(sessionId, userId);

  const pair = selectNextPair({
    pool: seen.map((m) => ({ movieId: m.id, moodVector: m.moodVector })),
    w,
    covariance,
    shownCounts,
    // After a rejection, refining around the same region wastes a round: the
    // user has said this whole neighbourhood is wrong tonight. Steer away from
    // it and ask somewhere genuinely different.
    avoidCenters: await getRejectedMidpoints(sessionId),
  });
  if (!pair) return null;

  const round = answered;
  await query(
    `INSERT INTO comparisons (session_id, round, movie_a_id, movie_b_id, eig)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, round) DO UPDATE SET
       movie_a_id = EXCLUDED.movie_a_id,
       movie_b_id = EXCLUDED.movie_b_id,
       eig = EXCLUDED.eig,
       shown_at = now()`,
    [sessionId, round, pair.a.movieId, pair.b.movieId, pair.score],
  );

  return {
    round,
    totalRounds: TOTAL_ROUNDS,
    a: byId.get(pair.a.movieId)!,
    b: byId.get(pair.b.movieId)!,
    neitherRemaining: MAX_NEITHER_PER_SESSION - (await countNeither(sessionId)),
  };
}

async function getShownCounts(sessionId: string): Promise<Map<number, number>> {
  const rows = await query<{ movie_id: number; shows: string }>(
    `SELECT movie_id, count(*) AS shows FROM (
       SELECT movie_a_id AS movie_id FROM comparisons WHERE session_id = $1
       UNION ALL
       SELECT movie_b_id FROM comparisons WHERE session_id = $1
     ) t GROUP BY movie_id`,
    [sessionId],
  );
  return new Map(rows.map((r) => [r.movie_id, Number(r.shows)]));
}

export async function recordChoice(
  sessionId: string,
  userId: string,
  round: number,
  winnerId: number,
): Promise<void> {
  await assertOwnership(sessionId, userId);
  const updated = await query(
    `UPDATE comparisons
        SET winner_id = $3, outcome = 'chose', answered_at = now()
      WHERE session_id = $1 AND round = $2
        AND $3 IN (movie_a_id, movie_b_id)
      RETURNING id`,
    [sessionId, round, winnerId],
  );
  if (updated.length === 0) {
    throw new Error("no such round, or that film was not one of the two shown");
  }
  // Being shown in a pair is itself evidence the user has seen both films.
  await query(
    `INSERT INTO seen_movies (user_id, movie_id, source, seen)
     SELECT $1, unnest(ARRAY[movie_a_id, movie_b_id]), 'comparison', true
       FROM comparisons WHERE session_id = $2 AND round = $3
     ON CONFLICT (user_id, movie_id) DO NOTHING`,
    [userId, sessionId, round],
  );
}

/**
 * The user has seen both films and wants neither tonight.
 *
 * Recorded as a real answer, not a skip: see getAnsweredComparisons for how it
 * is encoded. Returns whether the allowance is now used up, so the UI can hide
 * the button rather than offering something that will be refused.
 */
export async function recordNeither(
  sessionId: string,
  userId: string,
  round: number,
): Promise<{ remaining: number }> {
  await assertOwnership(sessionId, userId);

  const used = await countNeither(sessionId);
  if (used >= MAX_NEITHER_PER_SESSION) {
    throw new Error(
      `You have already passed on ${MAX_NEITHER_PER_SESSION} pairs this session — pick one of these two.`,
    );
  }

  const updated = await query(
    `UPDATE comparisons
        SET outcome = 'neither', winner_id = NULL, answered_at = now()
      WHERE session_id = $1 AND round = $2 AND outcome = 'pending'
      RETURNING id`,
    [sessionId, round],
  );
  if (updated.length === 0) throw new Error("no such unanswered round");

  // Being shown a pair still tells us the user has seen both films.
  await query(
    `INSERT INTO seen_movies (user_id, movie_id, source, seen)
     SELECT $1, unnest(ARRAY[movie_a_id, movie_b_id]), 'comparison', true
       FROM comparisons WHERE session_id = $2 AND round = $3
     ON CONFLICT (user_id, movie_id) DO NOTHING`,
    [userId, sessionId, round],
  );

  return { remaining: MAX_NEITHER_PER_SESSION - (used + 1) };
}

/**
 * The user has not seen one of the two films. Retire it from their pool and
 * discard the question so a fresh pair is drawn for the same round.
 */
export async function markNotSeen(
  sessionId: string,
  userId: string,
  movieId: number,
): Promise<void> {
  await assertOwnership(sessionId, userId);
  await markSeen(userId, [movieId], "skip", false);
  await query(
    `DELETE FROM comparisons
      WHERE session_id = $1 AND outcome = 'pending' AND $2 IN (movie_a_id, movie_b_id)`,
    [sessionId, movieId],
  );
}

// ---------------------------------------------------------------------------
// Producing the recommendation
// ---------------------------------------------------------------------------

export async function completeSession(
  sessionId: string,
  userId: string,
): Promise<SessionResult> {
  await assertOwnership(sessionId, userId);

  // With no answered comparisons the fit returns the prior, and recommending
  // from that would be dressing up a default as a reading of the user's mood.
  const answered = await getAnsweredComparisons(sessionId);
  if (answered.length === 0) {
    throw new Error("This session has no answered comparisons yet.");
  }

  const { w } = await fitSession(sessionId, userId);
  const candidates = await getCandidates(userId, w, CANDIDATE_POOL);

  if (candidates.length === 0) {
    throw new Error(
      "No unseen films left to recommend. Score more films with scripts/03-score-moods.ts.",
    );
  }

  // Retrieval by mood score, then diversity selection thins the shortlist so
  // the five picks are not five versions of the same film.
  const picks = selectRecommendations(candidates, w, { count: RECOMMENDATION_COUNT });

  await query(`DELETE FROM recommendations WHERE session_id = $1`, [sessionId]);
  for (const [index, pick] of picks.entries()) {
    await query(
      `INSERT INTO recommendations (session_id, movie_id, rank, score, rationale)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, pick.movie.id, index + 1, pick.score, pick.reasons.join(", ")],
    );
  }

  await query(
    `UPDATE sessions
        SET status = 'complete', mood_vector = $2::vector, completed_at = now()
      WHERE id = $1`,
    [sessionId, formatVector(w)],
  );

  return {
    moodWords: describeMood(w),
    recommendations: picks.map((pick, index) => ({
      movie: pick.movie,
      rank: index + 1,
      reasons: pick.reasons,
    })),
  };
}

export async function getSessionResult(
  sessionId: string,
  userId: string,
): Promise<SessionResult | null> {
  await assertOwnership(sessionId, userId);

  const [session] = await query<{ mood_vector: string | null; status: string }>(
    `SELECT mood_vector, status FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (!session || session.status !== "complete" || !session.mood_vector) return null;

  // The plot summary is loaded only here, where the UI actually shows it —
  // pulling ~4KB of text for all 150 shortlisted candidates would be waste.
  const rows = await query<{
    rank: number;
    rationale: string | null;
    id: number;
    title: string;
    year: number | null;
    director: string | null;
    genres: string[];
    runtime_minutes: number | null;
    poster_path: string | null;
    popularity: number;
    content_rating: string | null;
    plot_summary: string | null;
  }>(
    `SELECT r.rank, r.rationale,
            m.id, m.title, m.year, m.director, m.genres, m.runtime_minutes,
            m.poster_path, m.popularity, m.content_rating, m.plot_summary
       FROM recommendations r
       JOIN movies m ON m.id = r.movie_id
      WHERE r.session_id = $1
      ORDER BY r.rank`,
    [sessionId],
  );

  return {
    moodWords: describeMood(parseVector(session.mood_vector)!),
    recommendations: rows.map((row) => ({
      rank: row.rank,
      reasons: row.rationale ? row.rationale.split(", ").filter(Boolean) : [],
      movie: toMovie(row),
    })),
  };
}

/** Exported for the empty-session fallback in the UI. */
export function neutralPosterior() {
  return { w: new Array(MOOD_DIM).fill(0), covariance: identity(MOOD_DIM) };
}

export type { ScoredMovie };
