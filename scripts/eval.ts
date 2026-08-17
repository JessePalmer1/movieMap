/**
 * Held-out evaluation on real sessions.
 *
 * This is the script that decides whether the whole premise is sound. The
 * claim behind movieMap is that a person's choices *tonight* carry information
 * that their general taste does not. That claim is falsifiable, and this is
 * the falsification:
 *
 *   - Leave one comparison out of a session, fit on the rest, predict it.
 *   - Compare that against a single global weight vector fitted across every
 *     session from every user — a model with no notion of "tonight" at all.
 *
 * If per-session fitting does not beat the global vector, mood is not adding
 * anything and the product should be rethought rather than polished. Better to
 * learn that from this script than from six months of use.
 *
 * Run: npm run eval
 */

import "./_env";
import { dot, subtract } from "../src/lib/linalg";
import { Comparison, fitMoodVector } from "../src/lib/preference";
import { getPool, parseVector, query } from "../src/lib/db";

/** A session's comparisons, with the popularity of each side for the baseline. */
interface SessionData {
  sessionId: string;
  comparisons: Array<Comparison & { winnerPopularity: number; loserPopularity: number }>;
}

const LAMBDAS = [0.3, 1, 3, 10];

/** Sessions shorter than this cannot support leave-one-out. */
const MIN_COMPARISONS = 4;

async function loadSessions(): Promise<SessionData[]> {
  const rows = await query<{
    session_id: string;
    winner_vector: string;
    loser_vector: string;
    winner_popularity: number;
    loser_popularity: number;
  }>(
    `SELECT c.session_id,
            wm.mood_vector AS winner_vector,
            lm.mood_vector AS loser_vector,
            wm.popularity  AS winner_popularity,
            lm.popularity  AS loser_popularity
       FROM comparisons c
       JOIN movies wm ON wm.id = c.winner_id
       JOIN movies lm ON lm.id = CASE WHEN c.winner_id = c.movie_a_id
                                      THEN c.movie_b_id ELSE c.movie_a_id END
      WHERE c.winner_id IS NOT NULL
        AND wm.mood_vector IS NOT NULL
        AND lm.mood_vector IS NOT NULL
      ORDER BY c.session_id, c.round`,
  );

  const bySession = new Map<string, SessionData>();
  for (const row of rows) {
    if (!bySession.has(row.session_id)) {
      bySession.set(row.session_id, { sessionId: row.session_id, comparisons: [] });
    }
    bySession.get(row.session_id)!.comparisons.push({
      winner: parseVector(row.winner_vector)!,
      loser: parseVector(row.loser_vector)!,
      winnerPopularity: row.winner_popularity,
      loserPopularity: row.loser_popularity,
    });
  }

  return [...bySession.values()].filter((s) => s.comparisons.length >= MIN_COMPARISONS);
}

function accuracy(correct: number, total: number): string {
  return total === 0 ? "  n/a " : (correct / total).toFixed(3);
}

async function main() {
  const sessions = await loadSessions();

  if (sessions.length === 0) {
    console.log(
      `No sessions with at least ${MIN_COMPARISONS} answered comparisons yet.\n\n` +
        `Play through the app a few times (npm run dev), then run this again.\n` +
        `Until there is real data, scripts/calibrate.ts is the simulated stand-in.`,
    );
    await getPool().end();
    return;
  }

  const totalComparisons = sessions.reduce((n, s) => n + s.comparisons.length, 0);
  console.log(
    `${sessions.length} sessions, ${totalComparisons} comparisons ` +
      `(median ${median(sessions.map((s) => s.comparisons.length))} per session).\n`,
  );

  // The "no notion of tonight" model: one weight vector for everybody, fitted
  // on every comparison ever recorded.
  const allComparisons: Comparison[] = sessions.flatMap((s) => s.comparisons);

  console.log("  lambda   session-fit   global-fit   popularity   coin flip");
  console.log("  " + "-".repeat(60));

  for (const lambda of LAMBDAS) {
    let sessionCorrect = 0;
    let globalCorrect = 0;
    let popularityCorrect = 0;
    let total = 0;

    for (const session of sessions) {
      for (let held = 0; held < session.comparisons.length; held++) {
        const train = session.comparisons.filter((_, i) => i !== held);
        const test = session.comparisons[held];
        const difference = subtract(test.winner, test.loser);

        const { w } = fitMoodVector(train, { lambda });
        if (dot(w, difference) > 0) sessionCorrect++;

        // The global model must not see this comparison either, or it gets a
        // free look at the answer.
        const globalTrain = allComparisons.filter((c) => c !== test);
        const { w: globalW } = fitMoodVector(globalTrain, { lambda });
        if (dot(globalW, difference) > 0) globalCorrect++;

        // Naive baseline: the better-known film wins.
        if (test.winnerPopularity > test.loserPopularity) popularityCorrect++;

        total++;
      }
    }

    console.log(
      `  ${String(lambda).padEnd(9)}` +
        `${accuracy(sessionCorrect, total).padEnd(14)}` +
        `${accuracy(globalCorrect, total).padEnd(13)}` +
        `${accuracy(popularityCorrect, total).padEnd(13)}0.500`,
    );
  }

  console.log(
    `\nsession-fit  fitted on the rest of that session — the model the app ships.` +
      `\nglobal-fit   one weight vector across every session; no notion of "tonight".` +
      `\npopularity   the better-known film wins.` +
      `\n\nThe number that matters is session-fit vs global-fit. If session-fit does not` +
      `\nclearly win, the mood premise is not carrying its weight and the design needs` +
      `\nrethinking rather than tuning.`,
  );

  if (sessions.length < 20) {
    console.log(
      `\nCaveat: ${sessions.length} sessions is far too few to conclude anything.` +
        `\nTreat this as a smoke test until there are a few dozen.`,
    );
  }

  await getPool().end();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
