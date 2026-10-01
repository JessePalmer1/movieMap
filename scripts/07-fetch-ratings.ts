/**
 * Step 7: US content ratings (G / PG / PG-13 / R / NC-17) from Wikidata.
 *
 * Property P1657, CC0 like the rest of the catalogue spine — no licensing
 * tangle, unlike pulling certificates from IMDb or TMDB.
 *
 * Coverage runs about 75% across the best-known films and falls off for older
 * and non-US titles, which is fine: the column is nullable and the UI omits it
 * rather than guessing.
 *
 * Resumable — only films never probed are queried, so a film genuinely without
 * a US certificate is not re-asked on every run.
 *
 * Run: npx tsx scripts/07-fetch-ratings.ts [--limit 2000]
 */

import "./_env";
import { USER_AGENT, numericArg, progress, sleep } from "./_env";
import { getPool, query } from "../src/lib/db";

const ENDPOINT = "https://query.wikidata.org/sparql";
const CHUNK = 150;

/**
 * Wikidata carries historical and regional variants alongside the modern five.
 * Anything not on this list is dropped rather than shown to a user as-is.
 */
const CANONICAL: Record<string, string> = {
  g: "G",
  pg: "PG",
  "pg-13": "PG-13",
  r: "R",
  "nc-17": "NC-17",
  // Pre-1970 and transitional certificates, mapped to their closest modern
  // equivalent so the UI only ever shows five values.
  m: "PG",
  "m/pg": "PG",
  gp: "PG",
  x: "NC-17",
};

interface Binding {
  film?: { value: string };
  ratingLabel?: { value: string };
}

async function sparql(sparqlQuery: string, attempt = 1): Promise<Binding[]> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/sparql-results+json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ query: sparqlQuery }),
  });

  const body = await response.text();
  try {
    return JSON.parse(body).results.bindings as Binding[];
  } catch {
    if (attempt > 4) {
      throw new Error(`Wikidata returned non-JSON: ${body.slice(0, 160)}`);
    }
    console.warn(`\n  Wikidata hiccup (${response.status}); retrying`);
    await sleep(attempt * 8000);
    return sparql(sparqlQuery, attempt + 1);
  }
}

function normalise(label: string): string | null {
  return CANONICAL[label.trim().toLowerCase()] ?? null;
}

async function main() {
  const limit = numericArg("limit", Infinity);

  const pending = await query<{ id: number; wikidata_id: string }>(
    `SELECT id, wikidata_id
       FROM movies
      WHERE content_rating_fetched_at IS NULL
      ORDER BY popularity DESC
      ${Number.isFinite(limit) ? `LIMIT ${Math.floor(limit)}` : ""}`,
  );

  if (pending.length === 0) {
    console.log("Every film has already been probed for a content rating.");
    await getPool().end();
    return;
  }

  console.log(`Fetching content ratings for ${pending.length} films...\n`);
  const byWikidataId = new Map(pending.map((f) => [f.wikidata_id, f.id]));
  let found = 0;
  let done = 0;

  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    const bindings = await sparql(`
SELECT ?film ?ratingLabel WHERE {
  VALUES ?film { ${chunk.map((f) => `wd:${f.wikidata_id}`).join(" ")} }
  ?film wdt:P1657 ?rating .
  ?rating rdfs:label ?ratingLabel .
  FILTER(LANG(?ratingLabel) = "en")
}`);

    // A film can carry several certificates (re-releases, director's cuts).
    // Keep the first recognised one; they rarely disagree meaningfully.
    const resolved = new Map<number, string>();
    for (const binding of bindings) {
      const uri = binding.film?.value ?? "";
      const movieId = byWikidataId.get(uri.slice(uri.lastIndexOf("/") + 1));
      if (!movieId || resolved.has(movieId)) continue;
      const rating = normalise(binding.ratingLabel?.value ?? "");
      if (rating) resolved.set(movieId, rating);
    }

    for (const [movieId, rating] of resolved) {
      await query(`UPDATE movies SET content_rating = $2 WHERE id = $1`, [movieId, rating]);
      found++;
    }
    // Stamp the whole chunk so films without a certificate are not re-probed.
    await query(
      `UPDATE movies SET content_rating_fetched_at = now() WHERE id = ANY($1::int[])`,
      [chunk.map((f) => f.id)],
    );

    done += chunk.length;
    progress(done, pending.length, "probed");
    await sleep(1200);
  }

  const distribution = await query<{ content_rating: string; count: string }>(
    `SELECT content_rating, count(*) AS count
       FROM movies WHERE content_rating IS NOT NULL
      GROUP BY content_rating ORDER BY count DESC`,
  );

  console.log(`\nFound ${found} ratings.\n`);
  for (const row of distribution) {
    console.log(`  ${row.content_rating.padEnd(8)}${row.count}`);
  }
  await getPool().end();
}

main().catch((error) => {
  console.error("\n", (error as Error).message);
  process.exit(1);
});
