import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { getPopularMovies, getScoredMovieCount, getSeenMovieIds } from "@/lib/movies";

/**
 * The onboarding grid, plus whatever this browser has already told us.
 *
 * Uses getUserId rather than requireUserId: merely loading the page should not
 * mint a user row. The id is created when a session actually starts.
 */
export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 60);
  try {
    const userId = await getUserId();
    const [movies, scored, seenMovieIds] = await Promise.all([
      getPopularMovies(Math.min(Math.max(limit, 1), 200)),
      getScoredMovieCount(),
      userId ? getSeenMovieIds(userId) : Promise.resolve<number[]>([]),
    ]);
    return NextResponse.json({
      movies,
      scoredMovieCount: scored,
      seenMovieIds,
      returning: seenMovieIds.length > 0,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
