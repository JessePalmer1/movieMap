/**
 * Calibrates the ridge strength (lambda) and measures what active pair
 * selection buys us.
 *
 * Simulates users whose choices follow the Bradley-Terry model exactly, so
 * these numbers are an *upper bound* on real performance — a real user is
 * noisier and their mood is not perfectly linear in our 12 axes. The point is
 * to answer two questions before building any UI:
 *
 *   1. What lambda should the fit use?
 *   2. Is ~8 comparisons enough, and does active selection make it enough?
 *
 * Run: npx tsx scripts/calibrate.ts
 */

import { cosineSimilarity, dot, identity, subtract } from "../src/lib/linalg";
import { Comparison, fitMoodVector } from "../src/lib/preference";
import { MOOD_DIM } from "../src/lib/moodAxes";
import { PairCandidate, selectNextPair } from "../src/lib/pairSelection";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(rand: () => number, dim = MOOD_DIM): number[] {
  return Array.from({ length: dim }, () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  });
}

/** A Bradley-Terry user choosing between two films. */
function choose(wTrue: number[], a: number[], b: number[], rand: () => number): Comparison {
  const pAWins = 1 / (1 + Math.exp(-dot(wTrue, subtract(a, b))));
  return rand() < pAWins ? { winner: a, loser: b } : { winner: b, loser: a };
}

function simulateRandomPairs(wTrue: number[], n: number, rand: () => number): Comparison[] {
  return Array.from({ length: n }, () => choose(wTrue, randomVector(rand), randomVector(rand), rand));
}

// ---------------------------------------------------------------------------
// Part 1: lambda sweep, random pairs
// ---------------------------------------------------------------------------

const TRIALS = 2000;

console.log(`Simulated users: ${TRIALS} per cell, ${MOOD_DIM} mood dimensions.\n`);
console.log("PART 1 - ridge strength, random pairs");
console.log("  n   lambda   cos(w,true)   centroid    held-out acc");
console.log("  " + "-".repeat(50));

for (const n of [4, 8, 12, 24, 40]) {
  for (const lambda of [0.3, 1, 3]) {
    let cosTotal = 0;
    let centroidTotal = 0;
    let correct = 0;

    for (let trial = 0; trial < TRIALS; trial++) {
      const rand = rng(trial * 7919 + n * 31 + Math.round(lambda * 100));
      const wTrue = randomVector(rand);
      const all = simulateRandomPairs(wTrue, n + 1, rand);
      const train = all.slice(0, n);
      const heldOut = all[n];

      const { w } = fitMoodVector(train, { lambda });
      cosTotal += cosineSimilarity(w, wTrue);

      // The naive baseline this design exists to beat.
      const centroid = new Array(MOOD_DIM).fill(0);
      for (const c of train) {
        for (let i = 0; i < MOOD_DIM; i++) centroid[i] += c.winner[i];
      }
      centroidTotal += cosineSimilarity(centroid, wTrue);

      if (dot(w, subtract(heldOut.winner, heldOut.loser)) > 0) correct++;
    }

    console.log(
      `  ${String(n).padEnd(4)}${String(lambda).padEnd(9)}` +
        `${(cosTotal / TRIALS).toFixed(3).padEnd(14)}` +
        `${(centroidTotal / TRIALS).toFixed(3).padEnd(12)}` +
        `${(correct / TRIALS).toFixed(3)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Part 2: random vs active pair selection
// ---------------------------------------------------------------------------

const LAMBDA = 1;
const POOL_SIZE = 120; // films the simulated user has seen
const ACTIVE_TRIALS = 600;

/**
 * Runs one session, refitting after every answer. When `active` is set, the
 * next pair is chosen by BALD from the pool; otherwise it is drawn uniformly.
 */
function runSession(
  wTrue: number[],
  pool: PairCandidate[],
  rounds: number,
  active: boolean,
  rand: () => number,
): number[] {
  const comparisons: Comparison[] = [];
  const shownCounts = new Map<number, number>();
  let w = new Array(MOOD_DIM).fill(0);
  let covariance = identity(MOOD_DIM).map((row) => row.map((x) => x / LAMBDA));

  for (let round = 0; round < rounds; round++) {
    let a: PairCandidate;
    let b: PairCandidate;

    if (active) {
      const pair = selectNextPair({ pool, w, covariance, shownCounts, random: rand });
      if (!pair) break;
      a = pair.a;
      b = pair.b;
    } else {
      const eligible = pool.filter((m) => (shownCounts.get(m.movieId) ?? 0) < 2);
      if (eligible.length < 2) break;
      const i = Math.floor(rand() * eligible.length);
      let j = Math.floor(rand() * eligible.length);
      if (i === j) j = (j + 1) % eligible.length;
      a = eligible[i];
      b = eligible[j];
    }

    shownCounts.set(a.movieId, (shownCounts.get(a.movieId) ?? 0) + 1);
    shownCounts.set(b.movieId, (shownCounts.get(b.movieId) ?? 0) + 1);
    comparisons.push(choose(wTrue, a.moodVector, b.moodVector, rand));

    const fit = fitMoodVector(comparisons, { lambda: LAMBDA });
    w = fit.w;
    covariance = fit.covariance;
  }

  return w;
}

console.log("\nPART 2 - random vs active (BALD) pair selection");
console.log(`  pool of ${POOL_SIZE} seen films, lambda=${LAMBDA}, ${ACTIVE_TRIALS} users per cell`);
console.log("  rounds   random cos   active cos   lift");
console.log("  " + "-".repeat(46));

for (const rounds of [4, 6, 8, 10, 12, 16]) {
  let randomTotal = 0;
  let activeTotal = 0;

  for (let trial = 0; trial < ACTIVE_TRIALS; trial++) {
    // Same user, same seen-films pool, same seed for both arms — the only
    // difference is which pairs get shown.
    const setupRand = rng(trial * 104729 + rounds);
    const wTrue = randomVector(setupRand);
    const pool: PairCandidate[] = Array.from({ length: POOL_SIZE }, (_, i) => ({
      movieId: i,
      moodVector: randomVector(setupRand),
    }));

    randomTotal += cosineSimilarity(
      runSession(wTrue, pool, rounds, false, rng(trial * 31337 + rounds)),
      wTrue,
    );
    activeTotal += cosineSimilarity(
      runSession(wTrue, pool, rounds, true, rng(trial * 31337 + rounds)),
      wTrue,
    );
  }

  const randomCos = randomTotal / ACTIVE_TRIALS;
  const activeCos = activeTotal / ACTIVE_TRIALS;
  console.log(
    `  ${String(rounds).padEnd(9)}${randomCos.toFixed(3).padEnd(13)}` +
      `${activeCos.toFixed(3).padEnd(13)}${(activeCos - randomCos >= 0 ? "+" : "") + (activeCos - randomCos).toFixed(3)}`,
  );
}

// ---------------------------------------------------------------------------
// Part 3: recommendation quality
// ---------------------------------------------------------------------------

// Direction recovery is not the product metric. What matters is whether the
// films we surface are ones the user actually wants tonight. Ranking is far
// more forgiving than parameter recovery: getting the dominant axes right is
// enough to put good films at the top, even if the minor axes are noise.

const CATALOGUE_SIZE = 5000; // unseen films to rank
const REC_TRIALS = 400;

console.log("\nPART 3 - recommendation quality (active selection, lambda=1)");
console.log(`  ranking ${CATALOGUE_SIZE} unseen films, ${REC_TRIALS} users per cell`);
console.log("  rounds   top-1 pctile   top-3 best pctile   hit@1%   random baseline");
console.log("  " + "-".repeat(70));

for (const rounds of [4, 6, 8, 10, 12, 16]) {
  let top1Pctile = 0;
  let top3Pctile = 0;
  let hitTopPercent = 0;

  for (let trial = 0; trial < REC_TRIALS; trial++) {
    const setupRand = rng(trial * 15485863 + rounds);
    const wTrue = randomVector(setupRand);
    const pool: PairCandidate[] = Array.from({ length: POOL_SIZE }, (_, i) => ({
      movieId: i,
      moodVector: randomVector(setupRand),
    }));

    const w = runSession(wTrue, pool, rounds, true, rng(trial * 2654435761 + rounds));

    // Rank an unseen catalogue by the fitted mood vector, then score those
    // picks by the user's true utility.
    const catalogue = Array.from({ length: CATALOGUE_SIZE }, () => randomVector(setupRand));
    const trueUtilities = catalogue.map((v) => dot(wTrue, v));
    const sortedTrue = [...trueUtilities].sort((a, b) => a - b);
    const percentileOf = (u: number) => {
      // Fraction of the catalogue this film beats.
      let lo = 0;
      let hi = sortedTrue.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedTrue[mid] < u) lo = mid + 1;
        else hi = mid;
      }
      return lo / sortedTrue.length;
    };

    const ranked = catalogue
      .map((v, i) => ({ i, predicted: dot(w, v) }))
      .sort((a, b) => b.predicted - a.predicted);

    const top3 = ranked.slice(0, 3);
    top1Pctile += percentileOf(trueUtilities[top3[0].i]);
    top3Pctile += Math.max(...top3.map((r) => percentileOf(trueUtilities[r.i])));
    if (top3.some((r) => percentileOf(trueUtilities[r.i]) >= 0.99)) hitTopPercent++;
  }

  console.log(
    `  ${String(rounds).padEnd(9)}` +
      `${(top1Pctile / REC_TRIALS).toFixed(3).padEnd(15)}` +
      `${(top3Pctile / REC_TRIALS).toFixed(3).padEnd(20)}` +
      `${(hitTopPercent / REC_TRIALS).toFixed(3).padEnd(9)}0.500`,
  );
}

console.log(
  "\ncos(w,true) = direction recovery, 1.0 is perfect." +
    "\ncentroid    = averaging the chosen films instead (the approach this replaces)." +
    "\nheld-out    = accuracy predicting an unseen comparison; 0.5 is a coin flip." +
    "\n\nHeld-out accuracy cannot reach 1.0 even with a perfect fit: a Bradley-Terry" +
    "\nuser genuinely picks near-randomly between two films of similar mood." +
    "\n\ntop-N pctile = where our picks land in the user's true preference ordering." +
    "\n0.500 is what picking at random would score, 1.000 is their literal favourite.",
);
