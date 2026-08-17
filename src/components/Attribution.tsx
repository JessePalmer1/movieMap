/**
 * Source attribution.
 *
 * Not decorative — each line is a licence condition:
 *  - Wikidata is CC0 (no condition, credited anyway)
 *  - Wikipedia text is CC BY-SA, which requires attribution
 *  - TMDB's API terms require both the disclaimer sentence and their mark,
 *    and require that our own branding stay more prominent than theirs
 */
export function Attribution() {
  return (
    <footer className="border-t border-border/60 px-6 py-6 text-xs leading-relaxed text-muted">
      <div className="mx-auto max-w-4xl space-y-1">
        <p>
          Film data from{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href="https://www.wikidata.org"
            target="_blank"
            rel="noreferrer"
          >
            Wikidata
          </a>{" "}
          (CC0). Plot summaries from{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href="https://en.wikipedia.org"
            target="_blank"
            rel="noreferrer"
          >
            Wikipedia
          </a>{" "}
          (CC BY-SA).
        </p>
        <p>
          Poster images from TMDB. This product uses TMDB and the TMDB APIs but is not
          endorsed, certified, or otherwise approved by TMDB.
        </p>
      </div>
    </footer>
  );
}
