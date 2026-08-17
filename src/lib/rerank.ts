import Anthropic from "@anthropic-ai/sdk";
import { ScoredMovie } from "./movies";

/**
 * Reranking and explaining the shortlist.
 *
 * The linear mood model is good at ordering the whole catalogue but cannot
 * express interaction effects — "they picked comedies, but only ones with a
 * melancholy streak" is not a direction in mood space. So the model retrieves
 * the top hundred, and an LLM picks three from them with reasons.
 *
 * The rationale matters as much as the pick. A recommendation that explains
 * itself reads as insight; the same film with no explanation reads as a
 * random draw.
 *
 * Without ANTHROPIC_API_KEY this degrades to the top three by mood score,
 * which is a perfectly serviceable app — just a quieter one.
 */

const MODEL = "claude-sonnet-5";

export interface RerankInput {
  candidates: ScoredMovie[];
  /** The session's choices, most informative context we have. */
  comparisons: Array<{ chosen: string; rejected: string }>;
  /** Human-readable summary of the fitted mood, e.g. ["light", "fast", "warm"]. */
  moodWords: string[];
  count: number;
}

export interface RerankedPick {
  movie: ScoredMovie;
  rationale: string | null;
  reranked: boolean;
}

function describeCandidate(movie: ScoredMovie): string {
  const parts = [`[${movie.id}] ${movie.title}`];
  if (movie.year) parts.push(`(${movie.year})`);
  if (movie.director) parts.push(`dir. ${movie.director}`);
  if (movie.genres.length) parts.push(`— ${movie.genres.slice(0, 4).join(", ")}`);
  return parts.join(" ");
}

const SYSTEM_PROMPT = `You are choosing what someone should watch tonight.

You will be given:
- a series of forced choices the person just made between films they have already seen
- a shortlist of films they have NOT seen, already filtered to roughly match the mood implied by those choices

The choices are the real evidence. Read them as a pattern rather than individually: what changed between the films they took and the films they passed over? Pay attention to the combination — "comedies, but only melancholy ones" is the kind of thing the shortlist filter cannot capture, and the kind of thing you should.

Pick films that fit that pattern. Prefer a varied set: three films that are near-identical to each other is a worse answer than three that each fit for a different reason. Do not pick a film merely because it is famous.

For each pick write one sentence, addressed to the person, saying why it suits the mood they are in right now. Refer to their actual choices where it helps. Do not summarise the plot, do not use the words "mood vector" or "algorithm", and do not hedge.`;

function buildTool(count: number) {
  return {
    name: "recommend",
    description: `Choose exactly ${count} films from the shortlist.`,
    input_schema: {
      type: "object" as const,
      properties: {
        picks: {
          type: "array" as const,
          minItems: count,
          maxItems: count,
          items: {
            type: "object" as const,
            properties: {
              id: {
                type: "number" as const,
                description: "The bracketed id of a film from the shortlist.",
              },
              rationale: {
                type: "string" as const,
                description: "One sentence, addressed to the person, on why it fits tonight.",
              },
            },
            required: ["id", "rationale"],
          },
        },
      },
      required: ["picks"],
    },
  };
}

/** Top N by mood score. Used when there is no API key, or the call fails. */
function scoreOnlyFallback(candidates: ScoredMovie[], count: number): RerankedPick[] {
  return candidates.slice(0, count).map((movie) => ({
    movie,
    rationale: null,
    reranked: false,
  }));
}

export async function rerank(input: RerankInput): Promise<RerankedPick[]> {
  const { candidates, comparisons, moodWords, count } = input;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || candidates.length === 0 || comparisons.length === 0) {
    return scoreOnlyFallback(candidates, count);
  }

  const userMessage = [
    "Their choices, in order (they chose the first over the second):",
    ...comparisons.map((c, i) => `${i + 1}. ${c.chosen}  over  ${c.rejected}`),
    "",
    `The fitted mood reads as: ${moodWords.join(", ")}.`,
    "",
    `Shortlist of unseen films, already ordered by mood fit:`,
    ...candidates.map(describeCandidate),
    "",
    `Choose ${count}.`,
  ].join("\n");

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [buildTool(count)],
      tool_choice: { type: "tool", name: "recommend" },
      messages: [{ role: "user", content: userMessage }],
    });

    const toolUse = response.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return scoreOnlyFallback(candidates, count);

    const { picks } = toolUse.input as {
      picks?: Array<{ id: number; rationale: string }>;
    };
    if (!picks?.length) return scoreOnlyFallback(candidates, count);

    const byId = new Map(candidates.map((m) => [m.id, m]));
    const chosen: RerankedPick[] = [];
    const used = new Set<number>();

    for (const pick of picks) {
      const movie = byId.get(pick.id);
      // Guard against a hallucinated or repeated id.
      if (!movie || used.has(pick.id)) continue;
      used.add(pick.id);
      chosen.push({ movie, rationale: pick.rationale?.trim() || null, reranked: true });
      if (chosen.length === count) break;
    }

    // Top up from the score ordering if the model returned too few usable ids.
    for (const movie of candidates) {
      if (chosen.length >= count) break;
      if (used.has(movie.id)) continue;
      used.add(movie.id);
      chosen.push({ movie, rationale: null, reranked: false });
    }

    return chosen;
  } catch (error) {
    // A rerank failure must never cost the user their recommendation.
    console.error("rerank failed, falling back to mood score alone:", error);
    return scoreOnlyFallback(candidates, count);
  }
}
