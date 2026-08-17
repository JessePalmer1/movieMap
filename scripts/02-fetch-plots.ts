/**
 * Step 2: fetch plot summaries from the English Wikipedia.
 *
 * Wikipedia text is CC BY-SA. This is the text the mood scorer reads and the
 * embedder embeds — deliberately *not* TMDB overviews, whose terms forbid use
 * in connection with an ML/AI application.
 *
 * The plain-text extract API returns one article per request, so this is the
 * slow step. It is resumable: only films with no plot summary are fetched, so
 * an interrupted run can simply be restarted.
 *
 * Run: npx tsx scripts/02-fetch-plots.ts [--concurrency 4] [--limit 500]
 */

import "./_env";
import { USER_AGENT, isMain, numericArg, sleep } from "./_env";
import { getPool, query } from "../src/lib/db";

const API = "https://en.wikipedia.org/w/api.php";

/** Headings that hold the story, best first. */
const PLOT_HEADINGS = [
  "plot",
  "plot summary",
  "synopsis",
  "story",
  "premise",
  "plot synopsis",
  "summary",
];

const MAX_PLOT_CHARS = 4000;

interface Pending {
  id: number;
  title: string;
  article_title: string;
}

/**
 * Splits a plain-text extract into `== Heading ==` sections and returns the
 * best plot-like one, falling back to the lead paragraphs.
 */
export function extractPlot(extract: string): string | null {
  if (!extract.trim()) return null;

  const headingPattern = /^(={2,})\s*(.+?)\s*\1\s*$/gm;
  // `headingStart` is where the '== Heading ==' line begins, `start` where its
  // body begins. Both are needed: the body for the section itself, and the
  // heading position so the lead fallback stops before the first heading
  // rather than swallowing it.
  const sections: Array<{ heading: string; headingStart: number; start: number; end: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(extract)) !== null) {
    sections.push({
      heading: match[2].toLowerCase().trim(),
      headingStart: match.index,
      start: match.index + match[0].length,
      end: extract.length,
    });
    if (sections.length > 1) sections[sections.length - 2].end = match.index;
  }

  for (const wanted of PLOT_HEADINGS) {
    const section = sections.find((s) => s.heading === wanted);
    if (section) {
      const body = extract.slice(section.start, section.end).trim();
      if (body.length > 150) return body.slice(0, MAX_PLOT_CHARS);
    }
  }

  // No usable plot section — fall back to the lead, which at least describes
  // what kind of film it is.
  const lead = (
    sections.length > 0 ? extract.slice(0, sections[0].headingStart) : extract
  ).trim();
  return lead.length > 150 ? lead.slice(0, MAX_PLOT_CHARS) : null;
}

async function fetchExtract(articleTitle: string, attempt = 1): Promise<string | null> {
  const url = `${API}?${new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "extracts",
    explaintext: "1",
    redirects: "1",
    titles: articleTitle,
  })}`;

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

  if (response.status === 429 || response.status >= 500) {
    if (attempt > 4) return null;
    await sleep(attempt * 2000);
    return fetchExtract(articleTitle, attempt + 1);
  }
  if (!response.ok) return null;

  const json = (await response.json()) as {
    query?: { pages?: Array<{ extract?: string; missing?: boolean }> };
  };
  const page = json.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;
  return page.extract;
}

async function main() {
  const concurrency = numericArg("concurrency", 4);
  const limit = numericArg("limit", Infinity);

  const pending = await query<Pending>(
    `SELECT id, title, article_title
       FROM movies
      WHERE plot_summary IS NULL
        AND article_title IS NOT NULL
      ORDER BY popularity DESC
      ${Number.isFinite(limit) ? `LIMIT ${Math.floor(limit)}` : ""}`,
  );

  if (pending.length === 0) {
    console.log("Every film already has a plot summary. Nothing to do.");
    await getPool().end();
    return;
  }

  console.log(`Fetching ${pending.length} plot summaries (concurrency ${concurrency})...\n`);

  let index = 0;
  let fetched = 0;
  let failed = 0;
  const started = Date.now();

  // A pool of workers pulling from a shared cursor keeps exactly `concurrency`
  // requests in flight without batching stalls.
  async function worker() {
    while (index < pending.length) {
      const film = pending[index++];
      try {
        const extract = await fetchExtract(film.article_title);
        const plot = extract ? extractPlot(extract) : null;
        if (plot) {
          await query(
            `UPDATE movies SET plot_summary = $2, plot_fetched_at = now() WHERE id = $1`,
            [film.id, plot],
          );
          fetched++;
        } else {
          // Mark the attempt so a rerun does not retry it forever.
          await query(`UPDATE movies SET plot_fetched_at = now() WHERE id = $1`, [film.id]);
          failed++;
        }
      } catch {
        failed++;
      }

      const done = fetched + failed;
      if (done % 25 === 0 || done === pending.length) {
        const rate = done / ((Date.now() - started) / 1000);
        const remaining = Math.round((pending.length - done) / Math.max(rate, 0.01));
        process.stdout.write(
          `\r  ${done}/${pending.length}  ok=${fetched} miss=${failed}  ` +
            `${rate.toFixed(1)}/s  ~${Math.floor(remaining / 60)}m left      `,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(`\n\nDone. ${fetched} summaries stored, ${failed} without a usable plot section.`);
  await getPool().end();
}

// Guarded: this module exports extractPlot, and importing that must not start
// a fetch run.
if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error("\n", error);
    process.exit(1);
  });
}
