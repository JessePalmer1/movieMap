/**
 * Fitting a session mood vector from pairwise comparisons.
 *
 * Model: Bradley-Terry with linear utility over the 12 mood axes.
 *
 *     P(i beats j) = sigmoid( w . (v_i - v_j) )
 *
 * We fit `w` by ridge-regularised logistic regression on the *differences*.
 * This is structurally identical to an RLHF reward model.
 *
 * The thing not to do here — and the reason this file has so many comments — is
 * average the chosen movies' vectors. The signal lives in the differences. If a
 * user picks Heat over Amelie and then Amelie over Schindler's List, the
 * centroid of {Heat, Amelie} points nowhere meaningful, while the differences
 * describe a coherent direction.
 */

import {
  Matrix,
  Vector,
  dot,
  identity,
  inverse,
  logSigmoid,
  sigmoid,
  solve,
  subtract,
  zeroMatrix,
  zeros,
} from "./linalg";
import { MOOD_DIM } from "./moodAxes";

export interface Comparison {
  /** z-scored mood vector of the film the user chose. */
  winner: Vector;
  /** z-scored mood vector of the film the user passed over. */
  loser: Vector;
}

export interface FitOptions {
  /**
   * Ridge strength, pulling `w` toward `prior`. With ~8 comparisons over 12
   * dimensions the problem is underdetermined, so this is doing real work
   * rather than just guarding against separation. Tuned against held-out
   * pairwise accuracy in scripts/eval.ts.
   */
  lambda?: number;
  /**
   * Where to shrink toward. Zero (no mood preference) for a first-time user;
   * the user's long-term taste vector once we have session history.
   */
  prior?: Vector;
  maxIterations?: number;
  /** Converged when the largest gradient component falls below this. */
  tolerance?: number;
}

export interface FitResult {
  /** The fitted mood vector. Direction is what matters for ranking. */
  w: Vector;
  /**
   * Laplace-approximation posterior covariance (inverse Hessian at the
   * optimum). Pair selection uses this to find the comparisons that would
   * teach us the most.
   */
  covariance: Matrix;
  iterations: number;
  converged: boolean;
  /** Log-likelihood of the observed comparisons under the fitted model. */
  logLikelihood: number;
}

const DEFAULT_LAMBDA = 1.0;
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_TOLERANCE = 1e-8;

export function fitMoodVector(
  comparisons: Comparison[],
  options: FitOptions = {},
): FitResult {
  const {
    lambda = DEFAULT_LAMBDA,
    prior = zeros(MOOD_DIM),
    maxIterations = DEFAULT_MAX_ITERATIONS,
    tolerance = DEFAULT_TOLERANCE,
  } = options;

  if (lambda <= 0) {
    throw new Error("fitMoodVector: lambda must be positive (the fit is underdetermined without it)");
  }
  if (prior.length !== MOOD_DIM) {
    throw new Error(`fitMoodVector: prior must have ${MOOD_DIM} components, got ${prior.length}`);
  }

  // Every comparison collapses to a single difference vector, always oriented
  // winner-minus-loser, so the observed label is always +1.
  const diffs: Vector[] = comparisons.map(({ winner, loser }) => {
    if (winner.length !== MOOD_DIM || loser.length !== MOOD_DIM) {
      throw new Error(`fitMoodVector: mood vectors must have ${MOOD_DIM} components`);
    }
    return subtract(winner, loser);
  });

  // No data: the posterior is the prior.
  if (diffs.length === 0) {
    const cov = identity(MOOD_DIM).map((row) => row.map((x) => x / lambda));
    return { w: [...prior], covariance: cov, iterations: 0, converged: true, logLikelihood: 0 };
  }

  const objective = (w: Vector): number => {
    let nll = 0;
    for (const d of diffs) nll -= logSigmoid(dot(w, d));
    const delta = subtract(w, prior);
    return nll + (lambda / 2) * dot(delta, delta);
  };

  let w = [...prior];
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;

    // Gradient of the penalised negative log-likelihood.
    const grad = subtract(w, prior).map((x) => lambda * x);
    // Hessian, seeded with the ridge term (guarantees positive definiteness,
    // so Newton is always well-posed even when the data are separable).
    const hess: Matrix = zeroMatrix(MOOD_DIM, MOOD_DIM);
    for (let i = 0; i < MOOD_DIM; i++) hess[i][i] = lambda;

    for (const d of diffs) {
      const p = sigmoid(dot(w, d));
      const residual = 1 - p; // d(-log sigmoid)/d(w.d) = -(1 - p)
      const weight = p * (1 - p);
      for (let i = 0; i < MOOD_DIM; i++) {
        grad[i] -= residual * d[i];
        if (weight === 0) continue;
        for (let j = i; j < MOOD_DIM; j++) {
          hess[i][j] += weight * d[i] * d[j];
        }
      }
    }
    // Mirror the upper triangle we filled.
    for (let i = 0; i < MOOD_DIM; i++) {
      for (let j = i + 1; j < MOOD_DIM; j++) hess[j][i] = hess[i][j];
    }

    const gradMax = Math.max(...grad.map(Math.abs));
    if (gradMax < tolerance) {
      converged = true;
      break;
    }

    const step = solve(hess, grad);

    // Backtracking line search. Newton on a logistic objective can overshoot
    // when the comparisons are nearly separable; with the ridge term this
    // rarely triggers, but it costs almost nothing to be safe.
    let t = 1;
    const current = objective(w);
    let next = w.map((x, i) => x - t * step[i]);
    for (let bt = 0; bt < 20 && objective(next) > current; bt++) {
      t /= 2;
      next = w.map((x, i) => x - t * step[i]);
    }
    w = next;
  }

  // Rebuild the Hessian at the optimum for the covariance.
  const finalHess: Matrix = zeroMatrix(MOOD_DIM, MOOD_DIM);
  for (let i = 0; i < MOOD_DIM; i++) finalHess[i][i] = lambda;
  for (const d of diffs) {
    const p = sigmoid(dot(w, d));
    const weight = p * (1 - p);
    if (weight === 0) continue;
    for (let i = 0; i < MOOD_DIM; i++) {
      for (let j = 0; j < MOOD_DIM; j++) finalHess[i][j] += weight * d[i] * d[j];
    }
  }

  let logLikelihood = 0;
  for (const d of diffs) logLikelihood += logSigmoid(dot(w, d));

  return {
    w,
    covariance: inverse(finalHess),
    iterations,
    converged,
    logLikelihood,
  };
}

/** P(film a is preferred over film b) under the fitted mood vector. */
export function preferenceProbability(w: Vector, a: Vector, b: Vector): number {
  return sigmoid(dot(w, subtract(a, b)));
}

/** Utility of a single film under the fitted mood vector. Higher is better. */
export function scoreMovie(w: Vector, moodVector: Vector): number {
  return dot(w, moodVector);
}
