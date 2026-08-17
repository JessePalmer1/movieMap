import { describe, expect, it } from "vitest";
import { identity, subtract } from "./linalg";
import { MOOD_DIM } from "./moodAxes";
import { Comparison, fitMoodVector } from "./preference";
import { PairCandidate, expectedInformationGain, selectNextPair } from "./pairSelection";

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

function pool(rand: () => number, size: number): PairCandidate[] {
  return Array.from({ length: size }, (_, i) => ({
    movieId: i,
    moodVector: randomVector(rand),
  }));
}

const flatPrior = identity(MOOD_DIM);
const zero = new Array(MOOD_DIM).fill(0);

describe("expectedInformationGain", () => {
  it("is zero for two identical films", () => {
    expect(expectedInformationGain(zero, flatPrior, new Array(MOOD_DIM).fill(0))).toBeCloseTo(0, 9);
  });

  it("prefers a more separated pair when the model knows nothing", () => {
    const near = [0.1, ...new Array(MOOD_DIM - 1).fill(0)];
    const far = [3, ...new Array(MOOD_DIM - 1).fill(0)];
    expect(expectedInformationGain(zero, flatPrior, far)).toBeGreaterThan(
      expectedInformationGain(zero, flatPrior, near),
    );
  });

  it("prefers an uncertain outcome over one it can already predict", () => {
    // A strongly held weight on axis 0 makes that comparison predictable.
    const confident = [5, ...new Array(MOOD_DIM - 1).fill(0)];
    const alongKnownAxis = [2, ...new Array(MOOD_DIM - 1).fill(0)];
    const alongUnknownAxis = [0, 2, ...new Array(MOOD_DIM - 2).fill(0)];
    expect(expectedInformationGain(confident, flatPrior, alongUnknownAxis)).toBeGreaterThan(
      expectedInformationGain(confident, flatPrior, alongKnownAxis),
    );
  });
});

describe("selectNextPair", () => {
  it("returns null when fewer than two films are eligible", () => {
    const rand = rng(1);
    expect(selectNextPair({ pool: [], w: zero, covariance: flatPrior })).toBeNull();
    expect(
      selectNextPair({ pool: pool(rand, 1), w: zero, covariance: flatPrior }),
    ).toBeNull();
  });

  it("respects the per-film show limit", () => {
    const rand = rng(2);
    const candidates = pool(rand, 5);
    // Everything already shown twice except two films.
    const shownCounts = new Map(candidates.map((c) => [c.movieId, 2]));
    shownCounts.set(0, 0);
    shownCounts.set(1, 0);

    const pair = selectNextPair({
      pool: candidates,
      w: zero,
      covariance: flatPrior,
      shownCounts,
      random: rand,
    });
    expect(pair).not.toBeNull();
    expect([pair!.a.movieId, pair!.b.movieId].sort()).toEqual([0, 1]);
  });

  it("steers away from a region the user already rejected", () => {
    // Under a flat prior the score is monotonic in separation, so a contrived
    // two-cluster fixture just picks the widest cross-cluster pair either way.
    // The property that actually matters is distributional: averaged over many
    // pools, avoidance moves the chosen pair's midpoint further from the
    // rejected centre.
    let withoutDistance = 0;
    let withDistance = 0;
    const trials = 120;

    const distance = (p: { a: PairCandidate; b: PairCandidate }, center: number[]) => {
      let squared = 0;
      for (let i = 0; i < MOOD_DIM; i++) {
        const mid = (p.a.moodVector[i] + p.b.moodVector[i]) / 2;
        squared += (mid - center[i]) ** 2;
      }
      return Math.sqrt(squared);
    };

    for (let trial = 0; trial < trials; trial++) {
      const rand = rng(700 + trial);
      const candidates = pool(rand, 40);
      const center = randomVector(rng(9000 + trial));

      const without = selectNextPair({
        pool: candidates,
        w: zero,
        covariance: flatPrior,
        random: rng(1 + trial),
      })!;
      const withAvoid = selectNextPair({
        pool: candidates,
        w: zero,
        covariance: flatPrior,
        avoidCenters: [center],
        random: rng(1 + trial),
      })!;

      withoutDistance += distance(without, center);
      withDistance += distance(withAvoid, center);
    }

    expect(withDistance / trials).toBeGreaterThan(withoutDistance / trials);
  });

  it("still picks something when every region has been rejected", () => {
    const rand = rng(9);
    const candidates = pool(rand, 20);
    const pair = selectNextPair({
      pool: candidates,
      w: zero,
      covariance: flatPrior,
      avoidCenters: candidates.map((c) => c.moodVector),
      random: rand,
    });
    expect(pair).not.toBeNull();
  });
});

describe('"neither" encoding', () => {
  /**
   * The design decision this feature rests on: a rejected pair encoded as two
   * losses against a phantom average film beats discarding the answer. If this
   * ever inverts, the button should go back to being a plain skip.
   */
  it("beats discarding the answer", () => {
    const trials = 300;
    let encodedTotal = 0;
    let droppedTotal = 0;

    for (let trial = 0; trial < trials; trial++) {
      const rand = rng(4000 + trial);
      const wTrue = randomVector(rand);
      const origin = new Array(MOOD_DIM).fill(0);

      const encoded: Comparison[] = [];
      const dropped: Comparison[] = [];

      for (let round = 0; round < 10; round++) {
        const a = randomVector(rand);
        const b = randomVector(rand);
        const ua = a.reduce((s, x, i) => s + wTrue[i] * x, 0);
        const ub = b.reduce((s, x, i) => s + wTrue[i] * x, 0);

        // Rejects the pair when neither film clears the average film.
        if (Math.max(ua, ub) < 0) {
          encoded.push({ winner: origin, loser: a }, { winner: origin, loser: b });
          continue; // dropped: nothing recorded
        }
        const winnerIsA = 1 / (1 + Math.exp(-(ua - ub))) > rand();
        const comparison = winnerIsA ? { winner: a, loser: b } : { winner: b, loser: a };
        encoded.push(comparison);
        dropped.push(comparison);
      }

      const cos = (v: number[]) => {
        const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        const m = Math.sqrt(wTrue.reduce((s, x) => s + x * x, 0));
        return n === 0 ? 0 : v.reduce((s, x, i) => s + x * wTrue[i], 0) / (n * m);
      };
      encodedTotal += cos(fitMoodVector(encoded, { lambda: 1 }).w);
      droppedTotal += cos(fitMoodVector(dropped, { lambda: 1 }).w);
    }

    expect(encodedTotal / trials).toBeGreaterThan(droppedTotal / trials);
  });

  it("pushes a rejected film's score below the average film", () => {
    const disliked = randomVector(rng(55));
    const origin = new Array(MOOD_DIM).fill(0);
    const { w } = fitMoodVector(
      [{ winner: origin, loser: disliked }],
      { lambda: 0.5 },
    );
    // w . disliked < w . origin = 0
    expect(w.reduce((s, x, i) => s + x * disliked[i], 0)).toBeLessThan(0);
  });

  it("leaves the fit unchanged when a rejection is symmetric about the origin", () => {
    // Rejecting v and -v says "both below average" in opposite directions, so
    // the two constraints cancel and the direction should stay near neutral.
    const v = randomVector(rng(77));
    const origin = new Array(MOOD_DIM).fill(0);
    const { w } = fitMoodVector(
      [
        { winner: origin, loser: v },
        { winner: origin, loser: v.map((x) => -x) },
      ],
      { lambda: 1 },
    );
    const magnitude = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
    expect(magnitude).toBeLessThan(0.05);
  });
});

describe("subtract", () => {
  it("is the difference used throughout the fit", () => {
    expect(subtract([3, 1], [1, 4])).toEqual([2, -3]);
  });
});
