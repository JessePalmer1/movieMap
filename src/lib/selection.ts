import { cosineSimilarity, dot } from "./linalg";
import { MOOD_AXES } from "./moodAxes";
import { ScoredMovie } from "./movies";

/**
 * Choosing the final handful from the mood-ranked shortlist.
 *
 * Taking the top N by score alone produces near-duplicates, because films that
 * score well on one mood direction cluster together. Observed for real: a
 * "light" session returned two Leonid Gaidai comedies, and an "arty" one
 * returned two Tarkovsky films. Nothing was wrong with the scoring — argmax
 * simply has no notion that the second pick should say something the first did
 * not.
 *
 * The fix is maximal marginal relevance: pick the best film, then keep picking
 * the best film that is *not already represented*. Entirely deterministic, no
 * model involved.
 */

/** How hard to push for variety. 0 = pure score, 1 = pure novelty. */
const DEFAULT_DIVERSITY = 0.35;

export interface Recommendation {
  movie: ScoredMovie;
  /** Raw mood-fit score, w . v. */
  score: number;
  /**
   * The mood axes this film actually scored on, strongest first — derived from
   * which terms of the dot product contributed most. This is the payoff of
   * fitting over interpretable axes: a real explanation, computed rather than
   * written.
   */
  reasons: string[];
}

export interface SelectionOptions {
  count: number;
  diversity?: number;
}

/**
 * Words too common to identify a series on their own.
 *
 * The adjectives matter as much as the articles: without them "The Last
 * Samurai" and "The Last Emperor" share two leading words and would be treated
 * as one series.
 */
const WEAK_TOKENS = new Set([
  "the", "a", "an", "of", "and", "in", "on", "to", "movie", "film",
  "part", "chapter", "vol", "volume", "episode",
  "last", "first", "final", "great", "new", "my", "our",
]);

/**
 * Normalises a title to its leading words, dropping the subtitle after a colon
 * and any part numbers.
 */
export function titleTokens(title: string): string[] {
  let text = title.toLowerCase();
  const colon = text.indexOf(":");
  if (colon > 0) text = text.slice(0, colon);
  return text
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    // Part numbers, in digits or roman numerals, are what distinguishes
    // sequels — exactly what we want to ignore here.
    .filter((token) => !/^([ivxlcdm]+|\d+)$/.test(token));
}

/**
 * Whether two titles look like entries in the same series.
 *
 * Compares *leading words* rather than characters, because character prefixes
 * merge unrelated films: "The Terminator" and "The Terminal" share ten leading
 * characters but only the word "the".
 *
 * Same series when the stems match outright ("Rocky" / "Rocky III"), when one
 * stem extends the other ("Rocky" / "Rocky Balboa"), or when they share at
 * least two leading words — which is what catches "The SpongeBob Movie" and
 * "The SpongeBob SquarePants Movie", whose different directors and differing
 * colon placement defeat every simpler rule.
 *
 * Shared *endings* count too, since some series vary the first word instead:
 * "London Has Fallen" and "Olympus Has Fallen".
 *
 * In every case at least one shared word must be distinctive, so "The
 * Godfather" and "The Good, the Bad and the Ugly" stay separate.
 */
export function sameFranchise(a: string, b: string): boolean {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (left.length === 0 || right.length === 0) return false;

  const limit = Math.min(left.length, right.length);
  const distinctive = (tokens: string[]) => tokens.some((token) => !WEAK_TOKENS.has(token));

  let prefix = 0;
  while (prefix < limit && left[prefix] === right[prefix]) prefix++;
  if (prefix > 0 && distinctive(left.slice(0, prefix)) && (prefix >= 2 || prefix === limit)) {
    return true;
  }

  let suffix = 0;
  while (
    suffix < limit &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix++;
  }
  return suffix >= 2 && distinctive(left.slice(left.length - suffix));
}

/** The axes on which this film actually matched the fitted mood. */
export function reasonsFor(w: number[], moodVector: number[], topN = 2): string[] {
  return w
    .map((weight, i) => ({ i, contribution: weight * moodVector[i] }))
    // Only axes that pulled the score *up* are reasons to watch it.
    .filter((x) => x.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, topN)
    .map((x) => (w[x.i] > 0 ? MOOD_AXES[x.i].high : MOOD_AXES[x.i].low));
}

/**
 * Greedy MMR over the shortlist.
 *
 * `candidates` arrives already ranked by mood score; this reorders and thins
 * it. Director and franchise act as hard constraints while enough films remain
 * to honour them, then relax rather than returning fewer results than asked.
 */
export function selectRecommendations(
  candidates: ScoredMovie[],
  w: number[],
  options: SelectionOptions,
): Recommendation[] {
  const { count, diversity = DEFAULT_DIVERSITY } = options;
  if (candidates.length === 0) return [];

  const scored = candidates.map((movie) => ({ movie, score: dot(w, movie.moodVector) }));

  // Min-max onto [0,1] so relevance is comparable with cosine similarity.
  const scores = scored.map((s) => s.score);
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  const span = high - low || 1;
  const relevance = new Map(scored.map((s) => [s.movie.id, (s.score - low) / span]));

  const picked: Recommendation[] = [];
  const remaining = [...scored];
  const usedDirectors = new Set<string>();

  while (picked.length < count && remaining.length > 0) {
    // Only enforce the hard constraints while there is room to satisfy them.
    const slotsLeft = count - picked.length;
    const eligible = remaining.filter((c) => {
      const director = c.movie.director?.toLowerCase();
      if (director && usedDirectors.has(director)) return false;
      return !picked.some((p) => sameFranchise(c.movie.title, p.movie.title));
    });
    const pool = eligible.length >= slotsLeft ? eligible : remaining;

    let best = pool[0];
    let bestScore = -Infinity;

    for (const candidate of pool) {
      // Penalised by the nearest already-picked film, so a third pick is not
      // punished twice for resembling two similar earlier ones.
      let closest = 0;
      for (const chosen of picked) {
        closest = Math.max(
          closest,
          cosineSimilarity(candidate.movie.moodVector, chosen.movie.moodVector),
        );
      }
      const value =
        (1 - diversity) * (relevance.get(candidate.movie.id) ?? 0) - diversity * closest;
      if (value > bestScore) {
        bestScore = value;
        best = candidate;
      }
    }

    picked.push({
      movie: best.movie,
      score: best.score,
      reasons: reasonsFor(w, best.movie.moodVector),
    });

    const director = best.movie.director?.toLowerCase();
    if (director) usedDirectors.add(director);
    remaining.splice(remaining.indexOf(best), 1);
  }

  return picked;
}
