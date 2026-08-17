/**
 * Step 3: score every film on the 12 mood axes with an LLM.
 *
 * This is where the interpretable mood space actually comes from, and it is
 * the one irreplaceable step — everything downstream is arithmetic on these
 * numbers. The scores are derived from CC BY-SA Wikipedia text, so they are
 * ours to keep and publish.
 *
 * Films are scored in batches with a tool-use schema, which forces the model
 * to return every axis for every film rather than prose we would have to
 * parse. Resumable: only unscored films are sent.
 *
 * Run: npx tsx scripts/03-score-moods.ts [--limit 500] [--batch 12]
 *                                        [--concurrency 4] [--model claude-sonnet-5]
 */

import "./_env";
import Anthropic from "@anthropic-ai/sdk";
import { arg, numericArg, requireEnv } from "./_env";
import { getPool, query } from "../src/lib/db";
import { MOOD_AXES, MOOD_DIM, RAW_SCORE_MAX, RAW_SCORE_MIN } from "../src/lib/moodAxes";

const DEFAULT_MODEL = "claude-sonnet-5";
const PLOT_CHARS_PER_FILM = 1200;

interface Unscored {
  id: number;
  title: string;
  year: number | null;
  director: string | null;
  genres: string[];
  plot_summary: string;
}

const SYSTEM_PROMPT = `You rate films on fixed experiential axes for a mood-based recommendation engine.

You are not reviewing the film and you are not judging whether it is good. You are describing what it FEELS LIKE to watch it, so that someone can be matched to it based on the mood they are in tonight.

Score each axis from ${RAW_SCORE_MIN} to ${RAW_SCORE_MAX}, where ${RAW_SCORE_MIN} is the low anchor and ${RAW_SCORE_MAX} is the high anchor:

${MOOD_AXES.map(
  (a, i) => `${i + 1}. ${a.key} (${RAW_SCORE_MIN} = ${a.low}, ${RAW_SCORE_MAX} = ${a.high})
   ${a.guidance}`,
).join("\n\n")}

Use the full range. Most films should not cluster at 5 — if a film is genuinely light, score it 1, not 4. Reserve the extremes for films that truly sit at the anchor.

Judge the film as a whole, from what you know of it plus the plot summary provided. If you already know the film, use that knowledge; the summary is there to disambiguate and to help with films you do not know.`;

const scoreSchema = {
  type: "object" as const,
  properties: {
    films: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          id: { type: "number" as const, description: "The film's id, copied from the input." },
          ...Object.fromEntries(
            MOOD_AXES.map((a) => [
              a.key,
              {
                type: "number" as const,
                minimum: RAW_SCORE_MIN,
                maximum: RAW_SCORE_MAX,
                description: `${RAW_SCORE_MIN} = ${a.low}, ${RAW_SCORE_MAX} = ${a.high}`,
              },
            ]),
          ),
        },
        required: ["id", ...MOOD_AXES.map((a) => a.key)],
      },
    },
  },
  required: ["films"],
};

function describeFilm(film: Unscored): string {
  const bits = [
    `id: ${film.id}`,
    `title: ${film.title}${film.year ? ` (${film.year})` : ""}`,
    film.director ? `director: ${film.director}` : null,
    film.genres.length ? `genres: ${film.genres.slice(0, 6).join(", ")}` : null,
    `plot: ${film.plot_summary.slice(0, PLOT_CHARS_PER_FILM)}`,
  ].filter(Boolean);
  return bits.join("\n");
}

interface ScoredFilm {
  id: number;
  [axis: string]: number;
}

async function scoreBatch(
  client: Anthropic,
  model: string,
  batch: Unscored[],
  attempt = 1,
): Promise<ScoredFilm[]> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: "record_mood_scores",
          description: "Record mood axis scores for every film in the batch.",
          input_schema: scoreSchema,
        },
      ],
      tool_choice: { type: "tool", name: "record_mood_scores" },
      messages: [
        {
          role: "user",
          content: `Score all ${batch.length} of these films.\n\n${batch
            .map(describeFilm)
            .join("\n\n---\n\n")}`,
        },
      ],
    });

    const toolUse = response.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("model did not call the scoring tool");
    }
    return (toolUse.input as { films: ScoredFilm[] }).films ?? [];
  } catch (error) {
    if (attempt > 3) throw error;
    // Overload and rate limits are the common failures here; back off and retry.
    await new Promise((r) => setTimeout(r, attempt * 5000));
    return scoreBatch(client, model, batch, attempt + 1);
  }
}

function toVector(scored: ScoredFilm): number[] | null {
  const vector: number[] = [];
  for (const axis of MOOD_AXES) {
    const value = scored[axis.key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    // Clamp rather than reject: an occasional 10.5 is not worth a retry.
    vector.push(Math.min(RAW_SCORE_MAX, Math.max(RAW_SCORE_MIN, value)));
  }
  return vector.length === MOOD_DIM ? vector : null;
}

async function main() {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const model = arg("model") ?? DEFAULT_MODEL;
  const batchSize = numericArg("batch", 12);
  const concurrency = numericArg("concurrency", 4);
  const limit = numericArg("limit", Infinity);

  const pending = await query<Unscored>(
    `SELECT id, title, year, director, genres, plot_summary
       FROM movies
      WHERE mood_raw IS NULL
        AND plot_summary IS NOT NULL
      ORDER BY popularity DESC
      ${Number.isFinite(limit) ? `LIMIT ${Math.floor(limit)}` : ""}`,
  );

  if (pending.length === 0) {
    console.log("Every film with a plot summary is already scored. Nothing to do.");
    await getPool().end();
    return;
  }

  const batches: Unscored[][] = [];
  for (let i = 0; i < pending.length; i += batchSize) {
    batches.push(pending.slice(i, i + batchSize));
  }

  console.log(
    `Scoring ${pending.length} films in ${batches.length} batches of ${batchSize} ` +
      `using ${model} (concurrency ${concurrency}).\n`,
  );

  const client = new Anthropic({ apiKey });
  let cursor = 0;
  let scored = 0;
  let rejected = 0;
  const started = Date.now();

  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      let results: ScoredFilm[] = [];
      try {
        results = await scoreBatch(client, model, batch);
      } catch (error) {
        console.error(`\n  batch failed permanently: ${(error as Error).message}`);
        rejected += batch.length;
        continue;
      }

      const byId = new Map(batch.map((f) => [f.id, f]));
      for (const result of results) {
        if (!byId.has(result.id)) continue; // model invented an id
        const vector = toVector(result);
        if (!vector) {
          rejected++;
          continue;
        }
        await query(
          `UPDATE movies SET mood_raw = $2::real[], scored_at = now() WHERE id = $1`,
          [result.id, vector],
        );
        scored++;
      }

      const rate = scored / ((Date.now() - started) / 1000);
      process.stdout.write(
        `\r  ${scored}/${pending.length} scored  rejected=${rejected}  ${rate.toFixed(1)} films/s      `,
      );
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(`\n\nScored ${scored} films. ${rejected} could not be scored.`);
  console.log("Next: npx tsx scripts/05-normalize.ts");
  await getPool().end();
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
