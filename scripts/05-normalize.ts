/**
 * Step 5: z-score the raw mood scores across the corpus.
 *
 * The fitted weight vector is only comparable across axes if the axes have the
 * same scale. Raw LLM scores do not: 'tension' might spread across 0-10 while
 * 'nostalgia' clusters at 2-4, which would silently make nostalgia count for
 * less than tension in every fit.
 *
 * This also prints the per-axis distribution, which is the plan's sanity
 * check: an axis whose standard deviation is near zero is an axis the scorer
 * could not discriminate on, and should be reworded or cut.
 *
 * Cheap and idempotent — rerun it after every scoring pass.
 *
 * Run: npx tsx scripts/05-normalize.ts
 */

import "./_env";
import { formatVector, getPool, query } from "../src/lib/db";
import { MOOD_AXES, MOOD_DIM } from "../src/lib/moodAxes";

/** Below this, an axis is not telling films apart. */
const DEGENERATE_STD = 0.75;

async function main() {
  const rows = await query<{ id: number; mood_raw: number[] }>(
    `SELECT id, mood_raw FROM movies WHERE mood_raw IS NOT NULL`,
  );

  if (rows.length === 0) {
    console.log("No scored films yet. Run scripts/03-score-moods.ts first.");
    await getPool().end();
    return;
  }

  console.log(`Normalising ${rows.length} scored films.\n`);

  const means = new Array(MOOD_DIM).fill(0);
  const stds = new Array(MOOD_DIM).fill(0);

  for (let axis = 0; axis < MOOD_DIM; axis++) {
    const values = rows.map((r) => r.mood_raw[axis]);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    means[axis] = mean;
    // Guard against a constant axis producing division by zero.
    stds[axis] = Math.max(Math.sqrt(variance), 1e-6);
  }

  console.log("  axis          mean    std     min   max   spread");
  console.log("  " + "-".repeat(54));
  const degenerate: string[] = [];
  for (let axis = 0; axis < MOOD_DIM; axis++) {
    const values = rows.map((r) => r.mood_raw[axis]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const flag = stds[axis] < DEGENERATE_STD ? "  <-- too narrow" : "";
    if (stds[axis] < DEGENERATE_STD) degenerate.push(MOOD_AXES[axis].key);
    console.log(
      `  ${MOOD_AXES[axis].key.padEnd(13)}` +
        `${means[axis].toFixed(2).padEnd(8)}${stds[axis].toFixed(2).padEnd(8)}` +
        `${String(min).padEnd(6)}${String(max).padEnd(6)}${(max - min).toFixed(1)}${flag}`,
    );
  }

  let written = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples = batch.map((row, n) => {
      const normalised = row.mood_raw.map((v, axis) => (v - means[axis]) / stds[axis]);
      values.push(row.id, formatVector(normalised));
      return `($${n * 2 + 1}::int, $${n * 2 + 2}::vector)`;
    });
    await query(
      `UPDATE movies SET mood_vector = v.vec
         FROM (VALUES ${tuples.join(",")}) AS v(id, vec)
        WHERE movies.id = v.id`,
      values,
    );
    written += batch.length;
  }

  // Keep the normalisation constants so a single film scored later can be
  // placed on the same scale without renormalising the whole corpus.
  await query(
    `INSERT INTO mood_normalisation (id, means, stds, corpus_size, computed_at)
     VALUES (1, $1::real[], $2::real[], $3, now())
     ON CONFLICT (id) DO UPDATE SET
       means = EXCLUDED.means,
       stds = EXCLUDED.stds,
       corpus_size = EXCLUDED.corpus_size,
       computed_at = EXCLUDED.computed_at`,
    [means, stds, rows.length],
  );

  console.log(`\nWrote ${written} normalised mood vectors.`);
  if (degenerate.length > 0) {
    console.log(
      `\nWarning: ${degenerate.join(", ")} ${degenerate.length === 1 ? "has" : "have"} ` +
        `a standard deviation below ${DEGENERATE_STD}.\n` +
        `That axis is barely discriminating between films. Consider rewording its\n` +
        `guidance in src/lib/moodAxes.ts and rescoring, or dropping it.`,
    );
  }
  await getPool().end();
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
