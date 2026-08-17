/**
 * Minimal dense linear algebra for the 12-dimensional mood space.
 *
 * Everything here operates on matrices small enough (12x12) that clarity beats
 * cleverness — no blocking, no BLAS, no dependencies.
 */

export type Matrix = number[][];
export type Vector = number[];

export function zeros(n: number): Vector {
  return new Array(n).fill(0);
}

export function zeroMatrix(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array(cols).fill(0));
}

export function identity(n: number): Matrix {
  const m = zeroMatrix(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

export function dot(a: Vector, b: Vector): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function subtract(a: Vector, b: Vector): Vector {
  return a.map((x, i) => x - b[i]);
}

export function norm(a: Vector): number {
  return Math.sqrt(dot(a, a));
}

export function cosineSimilarity(a: Vector, b: Vector): number {
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot(a, b) / denom;
}

/**
 * Solves A x = b by Gaussian elimination with partial pivoting.
 * A and b are not mutated. Throws if A is singular to working precision.
 */
export function solve(A: Matrix, b: Vector): Vector {
  const n = A.length;
  if (n === 0) return [];
  if (A.some((row) => row.length !== n)) {
    throw new Error("solve: matrix must be square");
  }
  if (b.length !== n) {
    throw new Error(`solve: dimension mismatch (A is ${n}x${n}, b has ${b.length})`);
  }

  // Augmented copy so callers keep their inputs.
  const M: Matrix = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivot: largest magnitude in this column at or below the diagonal.
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error("solve: matrix is singular to working precision");
    }
    if (pivot !== col) [M[col], M[pivot]] = [M[pivot], M[col]];

    // Eliminate below.
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) M[row][k] -= factor * M[col][k];
    }
  }

  // Back-substitution.
  const x = zeros(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row][n];
    for (let k = row + 1; k < n; k++) sum -= M[row][k] * x[k];
    x[row] = sum / M[row][row];
  }
  return x;
}

/**
 * Inverts A by solving against each basis vector. Only used for the Laplace
 * covariance, which is 12x12 and computed once per session.
 */
export function inverse(A: Matrix): Matrix {
  const n = A.length;
  const cols: Vector[] = [];
  for (let i = 0; i < n; i++) {
    const e = zeros(n);
    e[i] = 1;
    cols.push(solve(A, e));
  }
  // cols[i] is the i-th column of the inverse; transpose into row-major.
  return Array.from({ length: n }, (_, r) => cols.map((c) => c[r]));
}

/** Numerically stable logistic function. */
export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** log(sigmoid(z)) without underflow for large negative z. */
export function logSigmoid(z: number): number {
  if (z >= 0) return -Math.log1p(Math.exp(-z));
  return z - Math.log1p(Math.exp(z));
}
