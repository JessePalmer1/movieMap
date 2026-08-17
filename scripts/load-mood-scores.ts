/**
 * Loads hand-authored mood scores from data/mood-scores/*.tsv.
 *
 * An alternative to scripts/03-score-moods.ts for when the scores are produced
 * directly rather than by an API call. Same destination (movies.mood_raw), same
 * 0-10 scale, so scripts/05-normalize.ts does not care which produced them.
 *
 * Format: tab-separated, one film per line, `#` for comments.
 *
 *     id	weight	humor	pace	demand	realism	warmth	scale	outlook	drive	attention	tension	nostalgia
 *
 * Column order is the order of MOOD_AXES in src/lib/moodAxes.ts. A header line
 * naming the axes is optional but checked when present, so a reordering of the
 * axes fails loudly instead of silently scrambling every score.
 *
 * Run: npx tsx scripts/load-mood-scores.ts [--dir data/mood-scores] [--dry-run]
 */

import "./_env";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { arg, flag } from "./_env";
import { getPool, query } from "../src/lib/db";
import { MOOD_AXES, MOOD_DIM, RAW_SCORE_MAX, RAW_SCORE_MIN } from "../src/lib/moodAxes";

interface ParsedRow {
  id: number;
  scores: number[];
  source: string;
  line: number;
}

function parseFile(path: string, filename: string): ParsedRow[] {
  const rows: ParsedRow[] = [];

  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return;

      const cells = line.split("\t").map((c) => c.trim());

      // Optional header: verify it matches the current axis order.
      if (cells[0].toLowerCase() === "id") {
        const declared = cells.slice(1).map((c) => c.toLowerCase());
        const expected = MOOD_AXES.map((a) => a.key.toLowerCase());
        if (declared.length !== expected.length ||
            declared.some((key, i) => key !== expected[i])) {
          throw new Error(
            `${filename}:${index + 1} header does not match MOOD_AXES.\n` +
              `  file:     ${declared.join(", ")}\n` +
              `  expected: ${expected.join(", ")}`,
          );
        }
        return;
      }

      if (cells.length !== MOOD_DIM + 1) {
        throw new Error(
          `${filename}:${index + 1} expected ${MOOD_DIM + 1} columns (id + ${MOOD_DIM} axes), got ${cells.length}`,
        );
      }

      const id = Number(cells[0]);
      if (!Number.isInteger(id)) {
        throw new Error(`${filename}:${index + 1} bad film id ${JSON.stringify(cells[0])}`);
      }

      const scores = cells.slice(1).map((cell, axis) => {
        const value = Number(cell);
        if (!Number.isFinite(value)) {
          throw new Error(
            `${filename}:${index + 1} ${MOOD_AXES[axis].key} is not a number: ${JSON.stringify(cell)}`,
          );
        }
        if (value < RAW_SCORE_MIN || value > RAW_SCORE_MAX) {
          throw new Error(
            `${filename}:${index + 1} ${MOOD_AXES[axis].key} = ${value} is outside ${RAW_SCORE_MIN}-${RAW_SCORE_MAX}`,
          );
        }
        return value;
      });

      rows.push({ id, scores, source: filename, line: index + 1 });
    });

  return rows;
}

async function main() {
  const dir = resolve(process.cwd(), arg("dir") ?? "data/mood-scores");
  const dryRun = flag("dry-run");

  let filenames: string[];
  try {
    filenames = readdirSync(dir).filter((f) => f.endsWith(".tsv")).sort();
  } catch {
    throw new Error(`No score directory at ${dir}`);
  }
  if (filenames.length === 0) throw new Error(`No .tsv files in ${dir}`);

  const rows = filenames.flatMap((f) => parseFile(join(dir, f), f));
  console.log(`Parsed ${rows.length} scored films from ${filenames.length} file(s).`);

  // A film scored twice, probably by a batch pasted in twice.
  const seen = new Map<number, ParsedRow>();
  for (const row of rows) {
    const previous = seen.get(row.id);
    if (previous) {
      throw new Error(
        `film ${row.id} scored twice: ${previous.source}:${previous.line} and ${row.source}:${row.line}`,
      );
    }
    seen.set(row.id, row);
  }

  // Ids that do not exist would silently update nothing.
  const known = await query<{ id: number }>(`SELECT id FROM movies WHERE id = ANY($1::int[])`, [
    [...seen.keys()],
  ]);
  const knownIds = new Set(known.map((r) => r.id));
  const unknown = [...seen.keys()].filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.length} id(s) are not in the catalogue: ${unknown.slice(0, 10).join(", ")}` +
        `${unknown.length > 10 ? ", ..." : ""}`,
    );
  }

  if (dryRun) {
    console.log("Dry run: everything parses and every id exists. Nothing written.");
    await getPool().end();
    return;
  }

  const values: unknown[] = [];
  const tuples = [...seen.values()].map((row, n) => {
    values.push(row.id, row.scores);
    return `($${n * 2 + 1}::int, $${n * 2 + 2}::real[])`;
  });

  await query(
    `UPDATE movies
        SET mood_raw = v.scores, scored_at = now()
       FROM (VALUES ${tuples.join(",")}) AS v(id, scores)
      WHERE movies.id = v.id`,
    values,
  );

  const [{ count }] = await query<{ count: string }>(
    `SELECT count(*) AS count FROM movies WHERE mood_raw IS NOT NULL`,
  );
  const [{ total }] = await query<{ total: string }>(
    `SELECT count(*) AS total FROM movies`,
  );

  console.log(`Wrote ${seen.size} score rows. ${count}/${total} films now scored.`);
  console.log("Next: npx tsx scripts/05-normalize.ts");
  await getPool().end();
}

main().catch((error) => {
  console.error("\n", (error as Error).message);
  process.exit(1);
});
