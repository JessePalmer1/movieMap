"use client";

import { useState } from "react";
import { Poster, PosterMovie } from "@/components/Poster";

export interface RecommendedMovie extends PosterMovie {
  genres: string[];
  runtimeMinutes: number | null;
  contentRating: string | null;
  plotSummary?: string | null;
}

function formatRuntime(minutes: number | null): string | null {
  if (!minutes || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

/**
 * One recommendation. The plot summary is hidden until asked for — a wall of
 * five synopses is unreadable, and the point of the page is the five posters.
 */
export function RecommendationCard({
  movie,
  reasons,
  priority = false,
}: {
  movie: RecommendedMovie;
  reasons: string[];
  priority?: boolean;
}) {
  const [showPlot, setShowPlot] = useState(false);
  const runtime = formatRuntime(movie.runtimeMinutes);

  return (
    <article className="animate-fade-up flex flex-col">
      <Poster movie={movie} size="w342" priority={priority} />

      <h2 className="mt-3 text-base font-semibold leading-tight">{movie.title}</h2>

      <p className="mt-1 text-sm text-muted">
        {[movie.year, movie.director].filter(Boolean).join(" · ")}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        {movie.contentRating && (
          <span className="rounded border border-border px-1.5 py-0.5 font-medium tracking-wide">
            {movie.contentRating}
          </span>
        )}
        {runtime && <span>{runtime}</span>}
      </div>

      {reasons.length > 0 && (
        // Derived from which mood axes contributed most to this film's score —
        // computed from the fit, not written by a model.
        <p className="mt-3 text-sm leading-relaxed text-foreground/85">
          Because you wanted something{" "}
          <span className="text-accent">{reasons.join(" and ")}</span>.
        </p>
      )}

      {movie.plotSummary && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowPlot((open) => !open)}
            aria-expanded={showPlot}
            className="text-xs text-muted underline underline-offset-2 transition hover:text-foreground"
          >
            {showPlot ? "Hide description" : "What's it about?"}
          </button>
          {showPlot && (
            <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-line rounded-md bg-surface p-3 text-xs leading-relaxed text-muted">
              {movie.plotSummary}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
