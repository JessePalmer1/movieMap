"use client";

import Image from "next/image";
import { useState } from "react";

export interface PosterMovie {
  id: number;
  title: string;
  year: number | null;
  director: string | null;
  posterPath: string | null;
}

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

/**
 * A film poster, or a typographic stand-in when we have no image.
 *
 * The fallback is deliberately not a grey box: without a TMDB key the entire
 * app runs on fallbacks, so it has to be good enough to choose between. Title
 * and year are all a viewer actually needs to recognise a film they have seen.
 */
export function Poster({
  movie,
  size = "w342",
  priority = false,
}: {
  movie: PosterMovie;
  size?: "w185" | "w342" | "w500";
  priority?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = movie.posterPath && !failed;

  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-surface-raised ring-1 ring-border">
      {showImage ? (
        <Image
          src={`${TMDB_IMAGE_BASE}/${size}${movie.posterPath}`}
          alt={`Poster for ${movie.title}`}
          fill
          sizes="(max-width: 640px) 45vw, (max-width: 1024px) 30vw, 320px"
          className="object-cover"
          priority={priority}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full flex-col justify-between p-4">
          <span className="font-mono text-[0.65rem] uppercase tracking-widest text-muted">
            {movie.year ?? " "}
          </span>
          <span className="text-balance text-lg font-semibold leading-tight">
            {movie.title}
          </span>
          <span className="line-clamp-2 text-xs text-muted">
            {movie.director ?? " "}
          </span>
        </div>
      )}
    </div>
  );
}
