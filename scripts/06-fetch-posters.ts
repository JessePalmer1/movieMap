/**
 * Step 6 (optional): fetch poster paths from TMDB.
 *
 * TMDB is used here for one thing only: pictures of film posters, at display
 * time. Their API terms forbid using TMDB content "in connection with ... a
 * machine learning (ML) or artificial intelligence (AI) based Application",
 * forbid derivatives, and cap caching at six months. Nothing TMDB returns is
 * ever fed to the mood scorer, the embedder, or the recommender — those read
 * only CC-licensed Wikidata and Wikipedia text.
 *
 * We store the poster *path*, not the image, and refresh anything older than
 * six months. Attribution is rendered in the app footer.
 *
 * Without TMDB_API_KEY the app falls back to typographic poster cards, which
 * works fine — it is just less pretty.
 *
 * Run: npx tsx scripts/06-fetch-posters.ts [--limit 500] [--concurrency 8]
 */

import "./_env";
import { numericArg, requireEnv, sleep } from "./_env";
import { getPool, query } from "../src/lib/db";

/** TMDB's caching limit. Anything older is refetched rather than reused. */
const CACHE_MAX_AGE = "6 months";

interface Pending {
  id: number;
  tmdb_id: number | null;
  imdb_id: string | null;
}

async function tmdb(path: string, apiKey: string, attempt = 1): Promise<unknown | null> {
  const url = `https://api.themoviedb.org/3${path}${path.includes("?") ? "&" : "?"}api_key=${apiKey}`;
  const response = await fetch(url);

  if (response.status === 429) {
    const wait = Number(response.headers.get("retry-after") ?? 1) * 1000 + 500;
    await sleep(wait);
    return attempt > 4 ? null : tmdb(path, apiKey, attempt + 1);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    if (attempt > 3) return null;
    await sleep(attempt * 2000);
    return tmdb(path, apiKey, attempt + 1);
  }
  return response.json();
}

async function posterFor(film: Pending, apiKey: string): Promise<string | null> {
  if (film.tmdb_id) {
    const movie = (await tmdb(`/movie/${film.tmdb_id}`, apiKey)) as { poster_path?: string } | null;
    if (movie?.poster_path) return movie.poster_path;
  }
  // Wikidata's TMDB id can be missing or stale; fall back to the IMDb id.
  if (film.imdb_id) {
    const found = (await tmdb(
      `/find/${film.imdb_id}?external_source=imdb_id`,
      apiKey,
    )) as { movie_results?: Array<{ poster_path?: string }> } | null;
    const hit = found?.movie_results?.[0];
    if (hit?.poster_path) return hit.poster_path;
  }
  return null;
}

async function main() {
  const apiKey = requireEnv("TMDB_API_KEY");
  const concurrency = numericArg("concurrency", 8);
  const limit = numericArg("limit", Infinity);

  const pending = await query<Pending>(
    `SELECT id, tmdb_id, imdb_id
       FROM movies
      WHERE (tmdb_id IS NOT NULL OR imdb_id IS NOT NULL)
        AND (poster_fetched_at IS NULL OR poster_fetched_at < now() - interval '${CACHE_MAX_AGE}')
      ORDER BY popularity DESC
      ${Number.isFinite(limit) ? `LIMIT ${Math.floor(limit)}` : ""}`,
  );

  if (pending.length === 0) {
    console.log("Every poster is present and within TMDB's six-month cache window.");
    await getPool().end();
    return;
  }

  console.log(`Fetching ${pending.length} poster paths (concurrency ${concurrency})...\n`);

  let cursor = 0;
  let found = 0;
  let missing = 0;

  async function worker() {
    while (cursor < pending.length) {
      const film = pending[cursor++];
      const poster = await posterFor(film, apiKey).catch(() => null);
      await query(
        `UPDATE movies SET poster_path = $2, poster_fetched_at = now() WHERE id = $1`,
        [film.id, poster],
      );
      if (poster) found++;
      else missing++;
      process.stdout.write(
        `\r  ${found + missing}/${pending.length}  found=${found} missing=${missing}      `,
      );
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`\n\nDone. ${found} posters, ${missing} without one.`);
  await getPool().end();
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
