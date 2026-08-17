"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Poster, PosterMovie } from "@/components/Poster";

interface PairMovie extends PosterMovie {
  genres: string[];
  runtimeMinutes: number | null;
}

export interface Pair {
  round: number;
  totalRounds: number;
  a: PairMovie;
  b: PairMovie;
  neitherRemaining: number;
}

/**
 * Drives the comparison rounds.
 *
 * The first pair arrives as a prop from the server, and every later pair is
 * fetched in response to a click — so there is no data-fetching effect, and no
 * empty first paint.
 *
 * The question asked is deliberately "which would you rather watch right now",
 * not "which is better". Asking which is better measures taste, which this
 * design holds constant by only ever comparing films the user has seen.
 */
export function ComparisonDeck({
  sessionId,
  initialPair,
}: {
  sessionId: string;
  initialPair: Pair;
}) {
  const router = useRouter();
  const [pair, setPair] = useState<Pair>(initialPair);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function advance() {
    const response = await fetch(`/api/session/${sessionId}/pair`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "could not load the next pair");

    if (data.done) {
      router.push(`/session/${sessionId}/result`);
      return;
    }
    setPair(data);
    setBusy(false);
  }

  async function post(body: Record<string, number | boolean>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/session/${sessionId}/choice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "could not record that");
      await advance();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const progress = (pair.round / pair.totalRounds) * 100;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-2 flex items-baseline justify-between gap-4 text-sm text-muted">
        <span>
          {pair.round + 1} of {pair.totalRounds}
        </span>
        <span className="text-right">Which would you rather watch right now?</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-raised">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {error && (
        <p className="mt-6 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      )}

      <div key={pair.round} className="animate-fade-up mt-10 grid grid-cols-2 gap-4 sm:gap-8">
        {[pair.a, pair.b].map((movie, index) => (
          <div key={movie.id} className="flex flex-col">
            <button
              type="button"
              onClick={() => post({ round: pair.round, winnerId: movie.id })}
              disabled={busy}
              className="group rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
            >
              <div className="transition group-hover:-translate-y-1 group-hover:brightness-110">
                <Poster movie={movie} size="w500" priority={index === 0} />
              </div>
              <div className="mt-3 text-left">
                <p className="font-semibold leading-tight">{movie.title}</p>
                <p className="mt-0.5 text-sm text-muted">
                  {[movie.year, movie.director].filter(Boolean).join(" · ")}
                </p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => post({ notSeenMovieId: movie.id })}
              disabled={busy}
              className="mt-2 self-start text-xs text-muted underline underline-offset-2 transition hover:text-foreground disabled:opacity-40"
            >
              I haven&apos;t seen this
            </button>
          </div>
        ))}
      </div>

      {/* Deliberately a quiet text link rather than a third button. Passing on
          a pair is real signal, but it is also the easiest thing to click, and
          someone pressing it out of indecision tells us something false. It
          should cost slightly more effort than choosing. */}
      {pair.neitherRemaining > 0 && (
        <div className="mt-8 text-center">
          <button
            type="button"
            onClick={() => post({ round: pair.round, neither: true })}
            disabled={busy}
            className="text-sm text-muted underline underline-offset-4 transition hover:text-foreground disabled:opacity-40"
          >
            Neither appeals right now
          </button>
        </div>
      )}

      <p className="mt-10 text-center text-xs text-muted">
        Not which is better — which one you actually want tonight.
      </p>
    </div>
  );
}
