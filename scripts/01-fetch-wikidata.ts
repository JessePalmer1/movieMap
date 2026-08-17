/**
 * Step 1: pull the film catalogue from Wikidata.
 *
 * Wikidata is CC0, which is why it is the spine of this project rather than
 * TMDB — nobody's terms of service can take it away, and unlike IMDb's and
 * MovieLens's datasets there is no restriction on building a public app from
 * it. See README for the full licensing picture.
 *
 * Popularity comes from `wikibase:sitelinks` (how many language Wikipedias
 * have an article on the film), which turns out to be a good CC0 proxy for
 * "would a normal person recognise this". It drives the onboarding grid.
 *
 * The Query Service enforces a 60s timeout, so the catalogue is fetched in
 * bands of sitelink count rather than one enormous query.
 *
 * Run: npx tsx scripts/01-fetch-wikidata.ts [--min-sitelinks 25] [--limit 500]
 */

import "./_env";
import { USER_AGENT, numericArg, progress, sleep } from "./_env";
import { getPool, query } from "../src/lib/db";

const ENDPOINT = "https://query.wikidata.org/sparql";

interface FilmRow {
  wikidataId: string;
  title: string;
  articleTitle: string;
  year: number | null;
  runtime: number | null;
  director: string | null;
  genres: string[];
  imdbId: string | null;
  tmdbId: number | null;
  sitelinks: number;
}

/**
 * Core film query for one sitelink band.
 *
 * Genres are deliberately NOT fetched here. Joining both director labels and
 * genre labels in one query produces a cross product per film, which pushes
 * the Query Service over its 60s budget and earns a 502. Genres come from a
 * second, much cheaper pass keyed on the ids we keep.
 */
function buildQuery(minSitelinks: number, maxSitelinks: number): string {
  // P31/Q11424 = instance of film. Requiring an English Wikipedia article is
  // not just a quality filter: step 2 needs it to fetch the plot summary.
  return `
SELECT ?film ?filmLabel ?articleTitle ?sitelinks ?imdb ?tmdb
       (MIN(?yearValue) AS ?year)
       (MIN(?runtimeValue) AS ?runtime)
       (SAMPLE(?directorName) AS ?director)
WHERE {
  ?film wdt:P31 wd:Q11424 ;
        wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${minSitelinks} && ?sitelinks < ${maxSitelinks})

  ?article schema:about ?film ;
           schema:isPartOf <https://en.wikipedia.org/> ;
           schema:name ?articleTitle .

  ?film rdfs:label ?filmLabel .
  FILTER(LANG(?filmLabel) = "en")

  OPTIONAL { ?film wdt:P345 ?imdb }
  OPTIONAL { ?film wdt:P4947 ?tmdb }
  # A film often carries several publication dates (festival, national
  # releases, anniversary re-releases). The earliest is the release year
  # everyone means, so aggregate with MIN rather than picking arbitrarily.
  OPTIONAL { ?film wdt:P577 ?date . BIND(YEAR(?date) AS ?yearValue) }
  # Likewise runtime, which varies across cuts.
  OPTIONAL { ?film wdt:P2047 ?runtimeValue }
  OPTIONAL {
    ?film wdt:P57 ?directorItem .
    ?directorItem rdfs:label ?directorName .
    FILTER(LANG(?directorName) = "en")
  }
}
GROUP BY ?film ?filmLabel ?articleTitle ?sitelinks ?imdb ?tmdb
ORDER BY DESC(?sitelinks)`;
}

/** Genres for an explicit list of film ids — cheap because the set is bound. */
function buildGenreQuery(wikidataIds: string[]): string {
  return `
SELECT ?film (GROUP_CONCAT(DISTINCT ?genreName; separator="|") AS ?genres)
WHERE {
  VALUES ?film { ${wikidataIds.map((id) => `wd:${id}`).join(" ")} }
  ?film wdt:P136 ?genreItem .
  ?genreItem rdfs:label ?genreName .
  FILTER(LANG(?genreName) = "en")
}
GROUP BY ?film`;
}

interface SparqlBinding {
  [key: string]: { value: string } | undefined;
}

async function runSparql(sparql: string, attempt = 1): Promise<SparqlBinding[]> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/sparql-results+json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ query: sparql }),
  });

  // WDQS is a free shared service and sheds load freely: 429 for rate limits,
  // 500/502/504 when a query exceeds its 60s budget or a backend is busy. All
  // of these are worth retrying with backoff.
  const retryable = [429, 500, 502, 503, 504];
  if (retryable.includes(response.status)) {
    if (attempt > 5) {
      throw new Error(
        `Wikidata kept returning ${response.status}. The query is probably too ` +
          `expensive for one band — try a narrower --min-sitelinks range.`,
      );
    }
    const wait = Number(response.headers.get("retry-after") ?? 0) * 1000 || attempt * 8000;
    console.warn(`\n  Wikidata returned ${response.status}; retrying in ${wait / 1000}s`);
    await sleep(wait);
    return runSparql(sparql, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(`Wikidata query failed: ${response.status} ${await response.text()}`);
  }

  // A timed-out query can still come back 200 with an HTML error body.
  const body = await response.text();
  let json: { results?: { bindings?: SparqlBinding[] } };
  try {
    json = JSON.parse(body);
  } catch {
    if (attempt > 5) throw new Error(`Wikidata returned non-JSON: ${body.slice(0, 200)}`);
    await sleep(attempt * 8000);
    return runSparql(sparql, attempt + 1);
  }
  return json.results?.bindings ?? [];
}

function toFilm(b: SparqlBinding): FilmRow | null {
  const uri = b.film?.value;
  const title = b.filmLabel?.value;
  const articleTitle = b.articleTitle?.value;
  if (!uri || !title || !articleTitle) return null;

  const year = b.year?.value ? Number(b.year.value) : null;
  const runtime = b.runtime?.value ? Math.round(Number(b.runtime.value)) : null;
  const tmdbRaw = b.tmdb?.value ? Number(b.tmdb.value) : null;

  return {
    wikidataId: uri.slice(uri.lastIndexOf("/") + 1),
    title,
    articleTitle,
    year: year && Number.isFinite(year) ? year : null,
    runtime: runtime && Number.isFinite(runtime) ? runtime : null,
    director: b.director?.value || null,
    genres: (b.genres?.value ?? "").split("|").filter(Boolean),
    imdbId: b.imdb?.value ?? null,
    tmdbId: tmdbRaw && Number.isFinite(tmdbRaw) ? tmdbRaw : null,
    sitelinks: Number(b.sitelinks?.value ?? 0),
  };
}

/**
 * Sitelink bands, most-famous first. Narrow at the top (few films, all of them
 * wanted) and wider lower down. Fetching in this order means `--limit` gives
 * you the N best-known films, which is exactly what a small test corpus wants.
 */
function bands(minSitelinks: number): Array<[number, number]> {
  // Even the most translated films top out around 200 sitelinks, so the bands
  // are dense in the 10-80 range where the catalogue actually lives.
  const edges = [10000, 100, 80, 68, 58, 50, 44, 39, 35, 31, 28, 25, 22, 19, 16, 13, 10, 7, 4, 0];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i + 1];
    const hi = edges[i];
    if (hi <= minSitelinks) break;
    out.push([Math.max(lo, minSitelinks), hi]);
  }
  return out;
}

async function main() {
  const minSitelinks = numericArg("min-sitelinks", 25);
  const limit = numericArg("limit", Infinity);

  console.log(
    `Fetching films from Wikidata (sitelinks >= ${minSitelinks}` +
      `${Number.isFinite(limit) ? `, stopping at ${limit} films` : ""}).\n`,
  );

  const films: FilmRow[] = [];
  const seen = new Set<string>();
  const bandList = bands(minSitelinks);

  for (const [lo, hi] of bandList) {
    if (films.length >= limit) break;
    process.stdout.write(`  sitelinks ${lo}-${hi}: querying... `);
    const bindings = await runSparql(buildQuery(lo, hi));

    let added = 0;
    for (const binding of bindings) {
      const film = toFilm(binding);
      // A film can appear twice if it has two English labels; keep the first.
      if (!film || seen.has(film.wikidataId)) continue;
      seen.add(film.wikidataId);
      films.push(film);
      added++;
      if (films.length >= limit) break;
    }
    console.log(`${added} films (${films.length} total)`);

    // Be a good citizen: WDQS is a free shared service.
    await sleep(1000);
  }

  if (films.length === 0) {
    throw new Error("Wikidata returned no films — check the query or the endpoint.");
  }

  // Second pass for genres, keyed on the ids we kept. Bound to an explicit
  // VALUES list, so this is cheap even though the first pass was not.
  console.log(`\nFetching genres for ${films.length} films...`);
  const byId = new Map(films.map((f) => [f.wikidataId, f]));
  const ids = [...byId.keys()];
  const GENRE_CHUNK = 250;
  for (let i = 0; i < ids.length; i += GENRE_CHUNK) {
    const chunk = ids.slice(i, i + GENRE_CHUNK);
    const bindings = await runSparql(buildGenreQuery(chunk));
    for (const binding of bindings) {
      const uri = binding.film?.value;
      if (!uri) continue;
      const film = byId.get(uri.slice(uri.lastIndexOf("/") + 1));
      if (film) film.genres = (binding.genres?.value ?? "").split("|").filter(Boolean);
    }
    progress(Math.min(i + GENRE_CHUNK, ids.length), ids.length, "genres");
    await sleep(500);
  }

  console.log(`\nUpserting ${films.length} films...`);
  let done = 0;
  const BATCH = 200;
  for (let i = 0; i < films.length; i += BATCH) {
    const batch = films.slice(i, i + BATCH);
    // One multi-row INSERT per batch rather than a round trip per film.
    const values: unknown[] = [];
    const tuples = batch.map((f, n) => {
      const o = n * 10;
      values.push(
        f.wikidataId,
        f.imdbId,
        f.tmdbId,
        f.title,
        f.year,
        f.runtime,
        f.director,
        f.genres,
        f.sitelinks,
        f.articleTitle,
      );
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8}::text[],$${o + 9},$${o + 10})`;
    });

    await query(
      `INSERT INTO movies
         (wikidata_id, imdb_id, tmdb_id, title, year, runtime_minutes, director, genres, popularity, article_title)
       VALUES ${tuples.join(",")}
       ON CONFLICT (wikidata_id) DO UPDATE SET
         imdb_id         = EXCLUDED.imdb_id,
         tmdb_id         = EXCLUDED.tmdb_id,
         title           = EXCLUDED.title,
         year            = EXCLUDED.year,
         runtime_minutes = EXCLUDED.runtime_minutes,
         director        = EXCLUDED.director,
         genres          = EXCLUDED.genres,
         popularity      = EXCLUDED.popularity,
         article_title   = EXCLUDED.article_title`,
      values,
    );
    done += batch.length;
    progress(done, films.length, "upserted");
  }

  const [{ count }] = await query<{ count: string }>("SELECT count(*) AS count FROM movies");
  console.log(`\nCatalogue now holds ${count} films.`);
  await getPool().end();
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
