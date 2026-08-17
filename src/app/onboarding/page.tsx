"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Poster, PosterMovie } from "@/components/Poster";

/**
 * The seen-list grid.
 *
 * This is the friction point of the whole product: nothing can be asked until
 * we know what the user has watched. Tapping posters is the cheapest honest
 * way to find out — roughly thirty seconds, no account, no import.
 */

const MIN_SEEN = 8;

interface GridMovie extends PosterMovie {
  genres: string[];
}

export default function OnboardingPage() {
  const router = useRouter();
  const [movies, setMovies] = useState<GridMovie[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/movies/popular?limit=72")
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setMovies(data.movies ?? []);
        if ((data.scoredMovieCount ?? 0) === 0) {
          setError(
            "No films have mood scores yet. Run the pipeline: npm run data:films, data:plots, data:moods, data:normalize.",
          );
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function toggle(id: number) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seenMovieIds: [...selected] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "could not start a session");
      router.push(`/session/${data.sessionId}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  }

  const remaining = MIN_SEEN - selected.size;

  return (
    <div className="mx-auto max-w-6xl px-6 py-12 pb-32">
      <h1 className="text-3xl font-bold tracking-tight">Which of these have you seen?</h1>
      <p className="mt-3 max-w-2xl text-muted">
        Tap everything you have watched — the more the better, and it does not matter
        whether you liked them. We only compare films you already know, so that what you
        pick reflects your mood rather than a guess about a film you have never seen.
      </p>

      {loading && <p className="mt-12 text-muted">Loading films…</p>}

      {error && (
        <p className="mt-8 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      )}

      <div className="mt-10 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {movies.map((movie) => {
          const isSelected = selected.has(movie.id);
          return (
            <button
              key={movie.id}
              type="button"
              onClick={() => toggle(movie.id)}
              aria-pressed={isSelected}
              className={`group relative rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                isSelected ? "ring-2 ring-accent" : "opacity-60 hover:opacity-100"
              }`}
            >
              <Poster movie={movie} size="w185" />
              {isSelected && (
                <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-sm font-bold text-accent-contrast">
                  ✓
                </span>
              )}
              <span className="mt-1.5 block truncate text-left text-[0.7rem] text-muted">
                {movie.title}
              </span>
            </button>
          );
        })}
      </div>

      {/* Pinned so the count and the button are reachable without scrolling back. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <span className="text-sm text-muted">
            {selected.size} selected
            {remaining > 0 && ` — ${remaining} more to start`}
          </span>
          <button
            type="button"
            onClick={start}
            disabled={selected.size < MIN_SEEN || starting}
            className="rounded-full bg-accent px-7 py-3 font-semibold text-accent-contrast transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {starting ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
