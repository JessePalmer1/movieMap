import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { completeSession, getSessionResult } from "@/lib/session";

/** The finished recommendation, computing it on first request. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "no session" }, { status: 401 });

  try {
    // Idempotent: a refresh returns the stored result rather than paying for
    // another rerank and handing back a different set of films.
    const existing = await getSessionResult(id, userId);
    if (existing) return NextResponse.json(existing);

    return NextResponse.json(await completeSession(id, userId));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
