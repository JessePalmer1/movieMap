import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { markNotSeen, recordChoice } from "@/lib/session";

/**
 * Records an answer.
 *
 * `{ round, winnerId }`      the user picked a film
 * `{ notSeenMovieId }`       the user has not seen one of the two; retire it
 *                            and draw a replacement for the same round
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "no session" }, { status: 401 });

  try {
    const body = (await request.json()) as {
      round?: number;
      winnerId?: number;
      notSeenMovieId?: number;
    };

    if (Number.isInteger(body.notSeenMovieId)) {
      await markNotSeen(id, userId, body.notSeenMovieId!);
      return NextResponse.json({ ok: true });
    }

    if (!Number.isInteger(body.round) || !Number.isInteger(body.winnerId)) {
      return NextResponse.json(
        { error: "expected { round, winnerId } or { notSeenMovieId }" },
        { status: 400 },
      );
    }

    await recordChoice(id, userId, body.round!, body.winnerId!);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
