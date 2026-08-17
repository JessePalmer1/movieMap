import { NextResponse } from "next/server";
import { getPopularMovies, getScoredMovieCount } from "@/lib/movies";

/** The onboarding grid. */
export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 60);
  try {
    const [movies, scored] = await Promise.all([
      getPopularMovies(Math.min(Math.max(limit, 1), 200)),
      getScoredMovieCount(),
    ]);
    return NextResponse.json({ movies, scoredMovieCount: scored });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
