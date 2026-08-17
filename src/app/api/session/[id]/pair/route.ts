import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { getNextPair } from "@/lib/session";

/** The next comparison, or `{ done: true }` when the session has enough. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "no session" }, { status: 401 });

  try {
    const pair = await getNextPair(id, userId);
    return pair ? NextResponse.json(pair) : NextResponse.json({ done: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
