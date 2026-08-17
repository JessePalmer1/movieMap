import { describe, expect, it } from "vitest";
import { cosineSimilarity, dot, identity, inverse, solve, subtract } from "./linalg";
import { Comparison, fitMoodVector, preferenceProbability } from "./preference";
import { MOOD_DIM } from "./moodAxes";

/** Deterministic PRNG so failures are reproducible. mulberry32. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller. Movie mood vectors are z-scored, so standard normal is the right shape. */
function randomVector(rand: () => number, dim = MOOD_DIM): number[] {
  return Array.from({ length: dim }, () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  });
}

/**
 * Simulates a user with a true mood vector `wTrue` choosing between films.
 * Choices follow the Bradley-Terry model, so they are genuinely noisy — a
 * close pair gets picked near-randomly, exactly as a real user would.
 */
function simulateSession(
  wTrue: number[],
  nComparisons: number,
  rand: () => number,
): Comparison[] {
  const comparisons: Comparison[] = [];
  for (let i = 0; i < nComparisons; i++) {
    const a = randomVector(rand);
    const b = randomVector(rand);
    const pAWins = 1 / (1 + Math.exp(-dot(wTrue, subtract(a, b))));
    comparisons.push(rand() < pAWins ? { winner: a, loser: b } : { winner: b, loser: a });
  }
  return comparisons;
}

describe("linalg", () => {
  it("solves a linear system", () => {
    const A = [
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2],
    ];
    const b = [8, -11, -3];
    const x = solve(A, b);
    expect(x[0]).toBeCloseTo(2, 10);
    expect(x[1]).toBeCloseTo(3, 10);
    expect(x[2]).toBeCloseTo(-1, 10);
  });

  it("inverts a matrix such that A * A^-1 = I", () => {
    const A = [
      [4, 7, 2],
      [3, 6, 1],
      [2, 5, 3],
    ];
    const inv = inverse(A);
    const I = identity(3);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const entry = A[i].reduce((s, aik, k) => s + aik * inv[k][j], 0);
        expect(entry).toBeCloseTo(I[i][j], 9);
      }
    }
  });

  it("rejects a singular matrix rather than returning garbage", () => {
    expect(() =>
      solve(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toThrow(/singular/);
  });
});

describe("fitMoodVector", () => {
  it("returns the prior when there are no comparisons", () => {
    const prior = randomVector(rng(1));
    const { w, converged } = fitMoodVector([], { prior, lambda: 2 });
    expect(converged).toBe(true);
    expect(w).toEqual(prior);
  });

  it("recovers the direction of a known mood vector", () => {
    // The headline check from the plan: with 8 comparisons over 12 dimensions,
    // does the fit point the right way? Averaged over many simulated users so
    // the result is not a single lucky seed.
    const trials = 200;
    let totalCosine = 0;
    for (let trial = 0; trial < trials; trial++) {
      const rand = rng(1000 + trial);
      const wTrue = randomVector(rand);
      const comparisons = simulateSession(wTrue, 8, rand);
      const { w } = fitMoodVector(comparisons, { lambda: 1 });
      totalCosine += cosineSimilarity(w, wTrue);
    }
    const meanCosine = totalCosine / trials;
    expect(meanCosine).toBeGreaterThan(0.5);
  });

  it("gets closer to the truth as more comparisons arrive", () => {
    const meanCosineAt = (n: number) => {
      const trials = 200;
      let total = 0;
      for (let trial = 0; trial < trials; trial++) {
        const rand = rng(5000 + trial);
        const wTrue = randomVector(rand);
        const comparisons = simulateSession(wTrue, n, rand);
        total += cosineSimilarity(fitMoodVector(comparisons, { lambda: 1 }).w, wTrue);
      }
      return total / trials;
    };
    const at4 = meanCosineAt(4);
    const at8 = meanCosineAt(8);
    const at24 = meanCosineAt(24);
    expect(at8).toBeGreaterThan(at4);
    expect(at24).toBeGreaterThan(at8);
    expect(at24).toBeGreaterThan(0.8);
  });

  it("beats averaging the chosen movies' vectors", () => {
    // This is the design decision the whole approach rests on. If naive
    // centroid-of-winners ever wins here, the premise is wrong.
    const trials = 300;
    let fitTotal = 0;
    let centroidTotal = 0;
    for (let trial = 0; trial < trials; trial++) {
      const rand = rng(9000 + trial);
      const wTrue = randomVector(rand);
      const comparisons = simulateSession(wTrue, 8, rand);

      fitTotal += cosineSimilarity(fitMoodVector(comparisons, { lambda: 1 }).w, wTrue);

      const centroid = new Array(MOOD_DIM).fill(0);
      for (const c of comparisons) {
        for (let i = 0; i < MOOD_DIM; i++) centroid[i] += c.winner[i] / comparisons.length;
      }
      centroidTotal += cosineSimilarity(centroid, wTrue);
    }
    expect(fitTotal / trials).toBeGreaterThan(centroidTotal / trials);
  });

  it("produces a positive-definite covariance whose scale shrinks with data", () => {
    const rand = rng(77);
    const wTrue = randomVector(rand);
    const few = fitMoodVector(simulateSession(wTrue, 4, rand), { lambda: 1 });
    const many = fitMoodVector(simulateSession(wTrue, 40, rand), { lambda: 1 });
    const trace = (m: number[][]) => m.reduce((s, row, i) => s + row[i], 0);
    // Diagonal entries are variances: strictly positive.
    for (let i = 0; i < MOOD_DIM; i++) expect(few.covariance[i][i]).toBeGreaterThan(0);
    // More evidence means less posterior uncertainty.
    expect(trace(many.covariance)).toBeLessThan(trace(few.covariance));
  });

  it("shrinks toward the prior as lambda grows", () => {
    const rand = rng(4242);
    const wTrue = randomVector(rand);
    const comparisons = simulateSession(wTrue, 8, rand);
    const weak = fitMoodVector(comparisons, { lambda: 0.1 });
    const strong = fitMoodVector(comparisons, { lambda: 100 });
    const magnitude = (v: number[]) => Math.sqrt(dot(v, v));
    expect(magnitude(strong.w)).toBeLessThan(magnitude(weak.w));
  });

  it("converges on every simulated session", () => {
    for (let trial = 0; trial < 100; trial++) {
      const rand = rng(31000 + trial);
      const wTrue = randomVector(rand);
      const result = fitMoodVector(simulateSession(wTrue, 8, rand), { lambda: 1 });
      expect(result.converged).toBe(true);
      expect(result.w.every(Number.isFinite)).toBe(true);
    }
  });

  it("handles perfectly separable comparisons without blowing up", () => {
    // A user who always picks the heavier film. Unregularised logistic
    // regression would send |w| to infinity here.
    const rand = rng(8);
    const comparisons: Comparison[] = [];
    for (let i = 0; i < 10; i++) {
      const a = randomVector(rand);
      const b = randomVector(rand);
      comparisons.push(a[0] > b[0] ? { winner: a, loser: b } : { winner: b, loser: a });
    }
    const { w, converged } = fitMoodVector(comparisons, { lambda: 1 });
    expect(converged).toBe(true);
    expect(w.every(Number.isFinite)).toBe(true);
    // The 'weight' axis should dominate.
    const biggest = w.map(Math.abs).indexOf(Math.max(...w.map(Math.abs)));
    expect(biggest).toBe(0);
  });
});

describe("preferenceProbability", () => {
  it("is symmetric and centred at one half for identical films", () => {
    const rand = rng(12);
    const w = randomVector(rand);
    const v = randomVector(rand);
    expect(preferenceProbability(w, v, v)).toBeCloseTo(0.5, 12);
  });

  it("complements when the arguments are swapped", () => {
    const rand = rng(13);
    const w = randomVector(rand);
    const a = randomVector(rand);
    const b = randomVector(rand);
    expect(preferenceProbability(w, a, b) + preferenceProbability(w, b, a)).toBeCloseTo(1, 12);
  });
});
