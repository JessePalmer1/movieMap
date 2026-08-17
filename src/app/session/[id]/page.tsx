import { redirect } from "next/navigation";
import { getUserId } from "@/lib/auth";
import { getNextPair } from "@/lib/session";
import { ComparisonDeck } from "@/components/ComparisonDeck";

/**
 * The comparison loop.
 *
 * The first pair is selected on the server so the page paints with a real
 * question rather than a spinner. Subsequent rounds are fetched by the client
 * component as the user answers.
 */
export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const userId = await getUserId();
  if (!userId) redirect("/onboarding");

  let pair;
  try {
    pair = await getNextPair(id, userId);
  } catch {
    redirect("/onboarding");
  }

  // Nothing left to ask — either the session is finished or the seen pool ran dry.
  if (!pair) redirect(`/session/${id}/result`);

  return <ComparisonDeck sessionId={id} initialPair={pair} />;
}
