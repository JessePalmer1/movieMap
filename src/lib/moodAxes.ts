/**
 * The 12 mood axes — the single source of truth.
 *
 * Shared by the offline LLM scoring prompt (scripts/03-score-moods.ts), the
 * preference fitting (lib/preference.ts), and the UI mood readout. Changing
 * this list invalidates every stored mood_vector, so treat it as a migration.
 *
 * Films are scored 0-10 on each axis by an LLM, then z-scored across the whole
 * corpus so that the fitted weight vector is comparable across axes.
 */

export interface MoodAxis {
  /** Stable identifier — used in the LLM's structured output. */
  key: string;
  /** Label for the 0 end of the scale. */
  low: string;
  /** Label for the 10 end of the scale. */
  high: string;
  /** Guidance given to the scoring model. */
  guidance: string;
}

export const MOOD_AXES: readonly MoodAxis[] = [
  {
    key: "weight",
    low: "light",
    high: "heavy",
    guidance:
      "How emotionally heavy is the film? 0 = breezy, no lasting weight. 10 = devastating, sits on your chest for days.",
  },
  {
    key: "humor",
    low: "funny",
    high: "serious",
    guidance:
      "How much is the film played for laughs? 0 = comedy throughout. 10 = entirely straight-faced, no levity.",
  },
  {
    key: "pace",
    low: "slow and contemplative",
    high: "fast and propulsive",
    guidance:
      "How quickly does it move? 0 = languid, long takes, drifting. 10 = relentless momentum, never stops.",
  },
  {
    key: "demand",
    low: "comforting and familiar",
    high: "challenging and demanding",
    guidance:
      "How much does it ask of the viewer? 0 = warm, predictable, easy to sink into. 10 = formally difficult, ambiguous, actively resists you.",
  },
  {
    key: "realism",
    low: "grounded",
    high: "fantastical",
    guidance:
      "How far from ordinary reality? 0 = could happen to anyone tomorrow. 10 = invented worlds, magic, far-future or myth.",
  },
  {
    key: "warmth",
    low: "warm",
    high: "cold",
    guidance:
      "The emotional temperature of the film's gaze on its characters. 0 = affectionate, generous, humane. 10 = clinical, detached, chilly.",
  },
  {
    key: "scale",
    low: "intimate",
    high: "epic",
    guidance:
      "The size of the canvas. 0 = a few people in a few rooms. 10 = armies, continents, decades, spectacle.",
  },
  {
    key: "outlook",
    low: "hopeful",
    high: "bleak",
    guidance:
      "Where it leaves you. 0 = uplifting, faith in people restored. 10 = despairing, no way out.",
  },
  {
    key: "drive",
    low: "plot-driven",
    high: "vibe-driven",
    guidance:
      "What carries it. 0 = strong plot engine, you watch to find out what happens. 10 = atmosphere and texture, plot is nearly beside the point.",
  },
  {
    key: "attention",
    low: "low attention cost",
    high: "high attention cost",
    guidance:
      "How much focus is required to follow it. 0 = you can look at your phone and stay oriented. 10 = miss two minutes and you are lost.",
  },
  {
    key: "tension",
    low: "calm",
    high: "tense",
    guidance:
      "Moment-to-moment anxiety. 0 = relaxing, no dread. 10 = sustained suspense, threat, or dread throughout.",
  },
  {
    key: "nostalgia",
    low: "present-focused",
    high: "nostalgic",
    guidance:
      "How much it trades on longing for the past — period setting, memory, or a deliberately retro texture. 0 = wholly of the now. 10 = saturated in longing for another time.",
  },
] as const;

export const MOOD_DIM = MOOD_AXES.length;

export const MOOD_AXIS_KEYS: readonly string[] = MOOD_AXES.map((a) => a.key);

/** Raw LLM scores are on this scale before z-scoring. */
export const RAW_SCORE_MIN = 0;
export const RAW_SCORE_MAX = 10;

/**
 * Axes weaker than this fraction of the strongest are treated as noise rather
 * than mood. Without it, a weight vector of all zeros — a session with no
 * answered comparisons — would be described as "light, funny, slow", which is
 * a confident claim about nothing.
 */
const RELATIVE_SIGNAL_FLOOR = 0.25;

/**
 * Turns a fitted weight vector into human-readable mood language, strongest
 * signal first. This is what makes the recommendation explainable — the whole
 * reason for fitting over an interpretable space rather than a raw embedding.
 *
 * Returns an empty array when there is no real signal, so callers can say so
 * rather than inventing a mood.
 */
export function describeMood(w: number[], topN = 3): string[] {
  if (w.length !== MOOD_DIM) {
    throw new Error(`describeMood: expected ${MOOD_DIM} weights, got ${w.length}`);
  }

  const strongest = Math.max(...w.map(Math.abs));
  if (strongest < 1e-9) return [];

  return w
    .map((weight, i) => ({ weight, axis: MOOD_AXES[i] }))
    .filter(({ weight }) => Math.abs(weight) >= strongest * RELATIVE_SIGNAL_FLOOR)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, topN)
    .map(({ weight, axis }) => (weight > 0 ? axis.high : axis.low));
}
