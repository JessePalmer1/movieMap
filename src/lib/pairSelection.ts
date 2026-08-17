/**
 * Choosing which two films to show next.
 *
 * Random pairs waste taps: two films with near-identical mood profiles teach
 * us nothing, and a pair whose outcome we can already predict teaches us
 * nothing either. We want the pair whose answer we are least able to guess and
 * which discriminates along axes we are still unsure about.
 *
 * The acquisition function is BALD (Bayesian Active Learning by Disagreement):
 * the mutual information between the unknown answer and the weight vector,
 *
 *     I[y ; w] = H( E_w[p] )  -  E_w[ H(p) ]
 *
 * using the standard closed-form approximation for logistic likelihoods under
 * a Gaussian posterior. High when the outcome is genuinely uncertain *because*
 * the model is uncertain, rather than because the two films are equally good.
 *
 * A pleasant property: on the first round the posterior is the isotropic prior
 * and the predictive mean is zero, so BALD reduces to maximising ||v_i - v_j||
 * — it picks maximally contrasting films with no special-casing needed.
 */

import { Matrix, Vector, dot, subtract } from "./linalg";
import { MOOD_DIM } from "./moodAxes";

export interface PairCandidate {
  movieId: number;
  moodVector: Vector;
}

export interface SelectPairOptions {
  /** Films the user has seen and not yet exhausted. */
  pool: PairCandidate[];
  /** Current posterior mean over mood weights. */
  w: Vector;
  /** Current posterior covariance (from fitMoodVector). */
  covariance: Matrix;
  /** How many times each movie has already been shown this session. */
  shownCounts?: Map<number, number>;
  /** A movie is retired from the pool after being shown this many times. */
  maxShowsPerMovie?: number;
  /** Random pairs to evaluate. Exhaustive search is unnecessary at this scale. */
  sampleSize?: number;
  /**
   * Midpoints of pairs the user rejected outright ("neither of these").
   *
   * Information gain alone would happily offer another pair from the same
   * neighbourhood, since the model is still uncertain there. But the user has
   * just said that whole region is wrong tonight, so refining inside it burns
   * a round. Pairs near these centres are penalised.
   */
  avoidCenters?: Vector[];
  /** Strength of that penalty, in the same units as the BALD score. */
  avoidWeight?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

export interface SelectedPair {
  a: PairCandidate;
  b: PairCandidate;
  /** Expected information gain in nats-equivalent BALD units. Higher is better. */
  score: number;
}

const DEFAULT_SAMPLE_SIZE = 400;
const DEFAULT_MAX_SHOWS = 2;

/**
 * BALD scores sit in [0, 1] bits, so this is a meaningful nudge that can still
 * be overridden by a genuinely much more informative pair.
 */
const DEFAULT_AVOID_WEIGHT = 0.3;

/**
 * Width of the avoidance kernel. Mood vectors are z-scored, so two unrelated
 * midpoints in 12 dimensions sit roughly sqrt(12/2) apart; at that distance the
 * penalty has essentially vanished.
 */
const AVOID_SCALE = Math.sqrt(MOOD_DIM / 2);

/** sqrt(pi * ln2 / 2), the constant in the BALD logistic approximation. */
const BALD_C = Math.sqrt((Math.PI * Math.LN2) / 2);

function binaryEntropy(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/** d^T Sigma d — the predictive variance along the difference direction. */
export function predictiveVariance(covariance: Matrix, d: Vector): number {
  let total = 0;
  for (let i = 0; i < d.length; i++) {
    if (d[i] === 0) continue;
    let rowSum = 0;
    for (let j = 0; j < d.length; j++) rowSum += covariance[i][j] * d[j];
    total += d[i] * rowSum;
  }
  // Numerical guard: covariance is positive definite, so this is >= 0 in exact
  // arithmetic, but round-off can produce a tiny negative near zero.
  return Math.max(total, 0);
}

/**
 * Expected information gain from asking about a pair with difference vector d.
 */
export function expectedInformationGain(w: Vector, covariance: Matrix, d: Vector): number {
  const mean = dot(w, d);
  const variance = predictiveVariance(covariance, d);

  // Posterior predictive probability, probit-approximated.
  const pBar = sigmoid(mean / Math.sqrt(1 + (Math.PI * variance) / 8));
  const marginalEntropy = binaryEntropy(pBar);

  // E_w[H(p)], closed-form approximation.
  const denom = Math.sqrt(variance + BALD_C * BALD_C);
  const expectedEntropy = (BALD_C / denom) * Math.exp(-(mean * mean) / (2 * denom * denom));

  return marginalEntropy - expectedEntropy;
}

/**
 * Picks the most informative pair from the pool. Returns null when fewer than
 * two eligible films remain.
 */
export function selectNextPair(options: SelectPairOptions): SelectedPair | null {
  const {
    pool,
    w,
    covariance,
    shownCounts = new Map(),
    maxShowsPerMovie = DEFAULT_MAX_SHOWS,
    sampleSize = DEFAULT_SAMPLE_SIZE,
    avoidCenters = [],
    avoidWeight = DEFAULT_AVOID_WEIGHT,
    random = Math.random,
  } = options;

  const eligible = pool.filter(
    (m) => (shownCounts.get(m.movieId) ?? 0) < maxShowsPerMovie,
  );
  if (eligible.length < 2) return null;

  let best: SelectedPair | null = null;

  const evaluate = (a: PairCandidate, b: PairCandidate) => {
    const difference = subtract(a.moodVector, b.moodVector);
    let score = expectedInformationGain(w, covariance, difference);

    if (avoidCenters.length > 0 && avoidWeight > 0) {
      const midpoint = a.moodVector.map((x, i) => (x + b.moodVector[i]) / 2);
      // Gaussian kernel: closest rejected region dominates, and the penalty
      // decays to nothing once the pair is a normal distance away.
      let strongest = 0;
      for (const center of avoidCenters) {
        let squared = 0;
        for (let i = 0; i < midpoint.length; i++) {
          const d = midpoint[i] - center[i];
          squared += d * d;
        }
        strongest = Math.max(strongest, Math.exp(-squared / (2 * AVOID_SCALE * AVOID_SCALE)));
      }
      score -= avoidWeight * strongest;
    }

    if (!best || score > best.score) best = { a, b, score };
  };

  const totalPairs = (eligible.length * (eligible.length - 1)) / 2;
  if (totalPairs <= sampleSize) {
    // Small pool: just look at everything.
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) evaluate(eligible[i], eligible[j]);
    }
  } else {
    for (let n = 0; n < sampleSize; n++) {
      const i = Math.floor(random() * eligible.length);
      let j = Math.floor(random() * eligible.length);
      if (i === j) j = (j + 1) % eligible.length;
      evaluate(eligible[i], eligible[j]);
    }
  }

  return best;
}
