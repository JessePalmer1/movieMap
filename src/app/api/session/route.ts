import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { reconcileGridSelection } from "@/lib/movies";
import { MIN_SEEN_MOVIES, createSession } from "@/lib/session";

/**
 * Starts a session: records what the user tapped in the onboarding grid, then
 * opens a session over that pool.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      seenMovieIds?: unknown;
      shownMovieIds?: unknown;
    };
    const asIds = (value: unknown) =>
      Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : [];

    const ids = asIds(body.seenMovieIds);
    // Which films the grid displayed, so unticking one can be distinguished
    // from a film that simply was not on screen.
    const shown = asIds(body.shownMovieIds);

    if (ids.length < MIN_SEEN_MOVIES) {
      return NextResponse.json(
        {
          error: `Pick at least ${MIN_SEEN_MOVIES} films you have seen — the comparisons need something to work with.`,
        },
        { status: 400 },
      );
    }

    const userId = await requireUserId();
    await reconcileGridSelection(userId, shown, ids);
    const sessionId = await createSession(userId);

    return NextResponse.json({ sessionId });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
