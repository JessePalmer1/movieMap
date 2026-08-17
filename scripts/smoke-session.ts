/**
 * Drives a full session against a running dev server, playing a scripted mood.
 *
 * This is the end-to-end check: onboarding, the comparison loop, fitting,
 * retrieval and the result page, all through the real HTTP API. Because the
 * simulated user answers according to a *known* rule, the recommendations are
 * falsifiable — ask for light films and you should not be handed Requiem for a
 * Dream.
 *
 * Run (with `npm run dev` already running):
 *   npx tsx scripts/smoke-session.ts --strategy light
 *   npx tsx scripts/smoke-session.ts --strategy heavy
 *   npx tsx scripts/smoke-session.ts --strategy tense
 *   npx tsx scripts/smoke-session.ts --strategy cosy
 */

import "./_env";
import { arg, flag, numericArg } from "./_env";
import { getPool, query } from "../src/lib/db";
import { MOOD_AXES } from "../src/lib/moodAxes";

const BASE = arg("base") ?? "http://localhost:3000";

/**
 * Each strategy is a direction in raw axis space that the simulated user is
 * drawn toward, and they pick whichever film scores higher along it. A
 * negative weight means they want a low score on that axis: `light` wants a
 * low `weight` score, so the weight is -1.
 */
const STRATEGIES: Record<string, { label: string; weights: Partial<Record<string, number>> }> = {
  light: { label: "something light and easy", weights: { weight: -1, humor: -1, attention: -1 } },
  heavy: { label: "something heavy and serious", weights: { weight: 1, humor: 1, demand: 1 } },
  tense: { label: "something tense", weights: { tension: 1, pace: 1 } },
  cosy: { label: "something warm and calm", weights: { warmth: -1, tension: -1, outlook: -1 } },
  arty: { label: "something slow and vibe-driven", weights: { drive: 1, pace: -1, demand: 1 } },
};

interface Jar {
  cookies: Map<string, string>;
}

async function call<T>(jar: Jar, path: string, init?: RequestInit): Promise<T> {
  const cookieHeader = [...jar.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });

  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${path} returned non-JSON (${response.status}): ${body.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${(parsed as { error?: string }).error}`);
  }
  return parsed as T;
}

/** Raw 0-10 axis scores, keyed by film id, for the simulated user's judgement. */
async function loadRawScores(): Promise<Map<number, number[]>> {
  const rows = await query<{ id: number; mood_raw: number[] }>(
    `SELECT id, mood_raw FROM movies WHERE mood_raw IS NOT NULL`,
  );
  return new Map(rows.map((r) => [r.id, r.mood_raw]));
}

function utility(scores: number[], weights: Partial<Record<string, number>>): number {
  let total = 0;
  MOOD_AXES.forEach((axis, i) => {
    const weight = weights[axis.key];
    if (weight) total += weight * scores[i];
  });
  return total;
}

interface Pair {
  round: number;
  totalRounds: number;
  a: { id: number; title: string; year: number | null };
  b: { id: number; title: string; year: number | null };
  neitherRemaining: number;
  done?: boolean;
}

async function main() {
  const name = arg("strategy") ?? "light";
  const strategy = STRATEGIES[name];
  if (!strategy) {
    throw new Error(`unknown strategy ${name}. Try: ${Object.keys(STRATEGIES).join(", ")}`);
  }
  const seenCount = numericArg("seen", 60);
  // --picky makes the simulated user pass on pairs that clear nothing, which
  // exercises the "neither" path end to end.
  const picky = flag("picky");
  const neitherThreshold = numericArg("neither-threshold", 0);

  const raw = await loadRawScores();
  const jar: Jar = { cookies: new Map() };

  console.log(`Simulated user wants: ${strategy.label}\n`);

  const popular = await call<{ movies: Array<{ id: number }> }>(
    jar,
    `/api/movies/popular?limit=${seenCount}`,
  );
  const { sessionId } = await call<{ sessionId: string }>(jar, "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seenMovieIds: popular.movies.map((m) => m.id) }),
  });

  for (let guard = 0; guard < 40; guard++) {
    const pair = await call<Pair>(jar, `/api/session/${sessionId}/pair`);
    if (pair.done) break;

    const scoreA = raw.get(pair.a.id);
    const scoreB = raw.get(pair.b.id);
    if (!scoreA || !scoreB) throw new Error("a shown film has no raw scores");

    const utilityA = utility(scoreA, strategy.weights);
    const utilityB = utility(scoreB, strategy.weights);

    // A picky user passes on any pair where neither film clears their bar.
    if (picky && pair.neitherRemaining > 0 && Math.max(utilityA, utilityB) < neitherThreshold) {
      console.log(
        `  ${String(pair.round + 1).padStart(2)}. neither: ` +
          `${pair.a.title.slice(0, 28)} / ${pair.b.title.slice(0, 28)}`,
      );
      await call(jar, `/api/session/${sessionId}/choice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ round: pair.round, neither: true }),
      });
      continue;
    }

    // Higher utility wins: the weights point toward what this user wants.
    const winner = utilityA >= utilityB ? pair.a : pair.b;
    const loser = winner.id === pair.a.id ? pair.b : pair.a;

    console.log(
      `  ${String(pair.round + 1).padStart(2)}. ${winner.title.slice(0, 34).padEnd(34)} ` +
        `over  ${loser.title.slice(0, 34)}`,
    );

    await call(jar, `/api/session/${sessionId}/choice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ round: pair.round, winnerId: winner.id }),
    });
  }

  const result = await call<{
    moodWords: string[];
    recommendations: Array<{
      rank: number;
      rationale: string | null;
      movie: { title: string; year: number | null };
    }>;
  }>(jar, `/api/session/${sessionId}/result`);

  console.log(`\n  fitted mood: ${result.moodWords.join(", ") || "(no clear signal)"}`);
  console.log("  recommended:");
  for (const rec of result.recommendations) {
    console.log(`    ${rec.rank}. ${rec.movie.title} (${rec.movie.year})`);
    if (rec.rationale) console.log(`       ${rec.rationale}`);
  }

  await getPool().end();
}

main().catch((error) => {
  console.error("\n", (error as Error).message);
  process.exit(1);
});
