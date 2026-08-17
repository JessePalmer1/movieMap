/**
 * Step 4 (optional): text embeddings of each film.
 *
 * Nothing in the recommendation path depends on this. The 12-dim mood vector
 * is what preferences are fitted over — a 1024-dim embedding cannot be fitted
 * from eight comparisons, which is the whole reason the mood space exists.
 *
 * What this is for: de-duplicating near-identical recommendations (a sequel
 * right below its original), "more like this" links, and future work that
 * needs finer-grained similarity than 12 axes can express.
 *
 * Skip it for a first run. Requires VOYAGE_API_KEY.
 *
 * Run: npx tsx scripts/04-embed.ts [--limit 500] [--batch 64]
 */

import "./_env";
import { numericArg, requireEnv, sleep } from "./_env";
import { formatVector, getPool, query } from "../src/lib/db";

const MODEL = "voyage-3.5";
const DIMENSIONS = 1024; // must match the vector(1024) column in db/schema.sql

interface Pending {
  id: number;
  title: string;
  year: number | null;
  director: string | null;
  genres: string[];
  plot_summary: string;
}

function documentFor(film: Pending): string {
  return [
    `${film.title}${film.year ? ` (${film.year})` : ""}`,
    film.director ? `Directed by ${film.director}` : "",
    film.genres.length ? `Genres: ${film.genres.join(", ")}` : "",
    film.plot_summary.slice(0, 2000),
  ]
    .filter(Boolean)
    .join("\n");
}

async function embed(apiKey: string, texts: string[], attempt = 1): Promise<number[][]> {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      input: texts,
      input_type: "document",
      output_dimension: DIMENSIONS,
    }),
  });

  if (response.status === 429 || response.status >= 500) {
    if (attempt > 4) throw new Error(`Voyage kept returning ${response.status}`);
    await sleep(attempt * 4000);
    return embed(apiKey, texts, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(`Voyage embedding failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
  // The API does not guarantee ordering; sort by the returned index.
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function main() {
  const apiKey = requireEnv("VOYAGE_API_KEY");
  const batchSize = numericArg("batch", 64);
  const limit = numericArg("limit", Infinity);

  const pending = await query<Pending>(
    `SELECT id, title, year, director, genres, plot_summary
       FROM movies
      WHERE embedding IS NULL AND plot_summary IS NOT NULL
      ORDER BY popularity DESC
      ${Number.isFinite(limit) ? `LIMIT ${Math.floor(limit)}` : ""}`,
  );

  if (pending.length === 0) {
    console.log("Every film with a plot summary is already embedded.");
    await getPool().end();
    return;
  }

  console.log(`Embedding ${pending.length} films with ${MODEL}...\n`);
  let done = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await embed(apiKey, batch.map(documentFor));

    if (vectors.length !== batch.length) {
      throw new Error(`expected ${batch.length} embeddings, got ${vectors.length}`);
    }
    for (const [n, film] of batch.entries()) {
      if (vectors[n].length !== DIMENSIONS) {
        throw new Error(
          `embedding dimension mismatch: got ${vectors[n].length}, schema expects ${DIMENSIONS}`,
        );
      }
      await query(`UPDATE movies SET embedding = $2::vector WHERE id = $1`, [
        film.id,
        formatVector(vectors[n]),
      ]);
    }

    done += batch.length;
    process.stdout.write(`\r  ${done}/${pending.length} embedded      `);
  }

  console.log("\n\nDone.");
  await getPool().end();
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
