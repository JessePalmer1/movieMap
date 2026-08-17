import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserId } from "@/lib/auth";
import { completeSession, getSessionResult } from "@/lib/session";
import { Poster } from "@/components/Poster";

/**
 * The payoff.
 *
 * Fitting, retrieval and rerank all happen here on the server. The result is
 * stored on first visit and read back on later ones, so a refresh does not pay
 * for another rerank or quietly hand back a different set of films.
 */
export default async function ResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const userId = await getUserId();
  if (!userId) redirect("/onboarding");

  let result;
  try {
    result = (await getSessionResult(id, userId)) ?? (await completeSession(id, userId));
  } catch (error) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24 text-center">
        <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {(error as Error).message}
        </p>
        <Link
          href="/onboarding"
          className="mt-6 inline-block rounded-full border border-border px-6 py-2.5 text-sm hover:bg-surface"
        >
          Start over
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <p className="text-sm uppercase tracking-widest text-muted">Tonight you are after</p>
      {/* The mood readout is the payoff of fitting over interpretable axes
          rather than a raw embedding — it is what makes the pick feel reasoned
          instead of arbitrary. */}
      <h1 className="mt-2 text-4xl font-bold tracking-tight">
        something {result.moodWords.join(", ")}
      </h1>

      <div className="mt-12 grid gap-8 sm:grid-cols-3">
        {result.recommendations.map(({ movie, rationale, rank }) => (
          <article key={movie.id} className="animate-fade-up flex flex-col">
            <Poster movie={movie} size="w500" priority={rank === 1} />
            <h2 className="mt-4 text-lg font-semibold leading-tight">{movie.title}</h2>
            <p className="mt-1 text-sm text-muted">
              {[
                movie.year,
                movie.director,
                movie.runtimeMinutes ? `${movie.runtimeMinutes} min` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {rationale && (
              <p className="mt-3 text-sm leading-relaxed text-foreground/85">{rationale}</p>
            )}
          </article>
        ))}
      </div>

      <div className="mt-16 flex flex-wrap gap-3">
        <Link
          href="/onboarding"
          className="rounded-full bg-accent px-7 py-3 font-semibold text-accent-contrast transition hover:brightness-110"
        >
          Go again
        </Link>
        <Link
          href="/"
          className="rounded-full border border-border px-7 py-3 transition hover:bg-surface"
        >
          Home
        </Link>
      </div>
    </div>
  );
}
