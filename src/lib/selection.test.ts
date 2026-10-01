import { describe, expect, it } from "vitest";
import { MOOD_DIM } from "./moodAxes";
import { ScoredMovie } from "./movies";
import { reasonsFor, sameFranchise, selectRecommendations } from "./selection";

function film(
  id: number,
  title: string,
  director: string | null,
  moodVector: number[],
): ScoredMovie {
  return {
    id,
    title,
    year: 2000,
    director,
    genres: [],
    runtimeMinutes: 100,
    posterPath: null,
    popularity: 50,
    contentRating: null,
    moodVector,
  };
}

/** Mood vector that is `value` on one axis and zero elsewhere. */
function onAxis(axis: number, value: number): number[] {
  const v = new Array(MOOD_DIM).fill(0);
  v[axis] = value;
  return v;
}

describe("sameFranchise", () => {
  it("groups colon-separated series entries", () => {
    expect(
      sameFranchise("Star Wars: Episode IV – A New Hope", "Star Wars: Episode V – The Empire Strikes Back"),
    ).toBe(true);
    expect(sameFranchise("Avengers: Endgame", "Avengers: Infinity War")).toBe(true);
  });

  it("groups sequels marked by part numbers", () => {
    expect(sameFranchise("The Godfather", "The Godfather Part II")).toBe(true);
    expect(sameFranchise("Rocky", "Rocky III")).toBe(true);
    expect(sameFranchise("Toy Story", "Toy Story 3")).toBe(true);
    expect(sameFranchise("Kill Bill: Volume 1", "Kill Bill: Volume 2")).toBe(true);
  });

  it("groups a stem with its extension", () => {
    expect(sameFranchise("Rocky", "Rocky Balboa")).toBe(true);
    expect(sameFranchise("The Dark Knight", "The Dark Knight Rises")).toBe(true);
  });

  it("groups the SpongeBob films, whose colons and directors differ", () => {
    // The case that defeated character-prefix and colon-only matching, and the
    // reason this function exists.
    expect(
      sameFranchise("The SpongeBob Movie: Sponge Out of Water", "The SpongeBob SquarePants Movie"),
    ).toBe(true);
  });

  it("groups a series that shares leading words without a colon", () => {
    expect(
      sameFranchise(
        "Harry Potter and the Philosopher's Stone",
        "Harry Potter and the Chamber of Secrets",
      ),
    ).toBe(true);
  });

  it("groups a series that varies the first word instead of the last", () => {
    expect(sameFranchise("London Has Fallen", "Olympus Has Fallen")).toBe(true);
  });

  it("keeps films apart that merely share a generic adjective", () => {
    expect(sameFranchise("The Last Samurai", "The Last Emperor")).toBe(false);
    expect(sameFranchise("The Great Dictator", "The Great Escape")).toBe(false);
  });

  it("keeps unrelated films apart despite similar spelling", () => {
    // Ten shared leading characters, one shared leading word.
    expect(sameFranchise("The Terminator", "The Terminal")).toBe(false);
    expect(sameFranchise("The Godfather", "The Good, the Bad and the Ugly")).toBe(false);
    expect(sameFranchise("Casablanca", "Cabaret")).toBe(false);
    expect(sameFranchise("Heat", "Her")).toBe(false);
  });

  it("does not group on a shared article alone", () => {
    expect(sameFranchise("The Shining", "The Departed")).toBe(false);
    expect(sameFranchise("A Serious Man", "A Beautiful Mind")).toBe(false);
  });
});

describe("reasonsFor", () => {
  it("names the axis the film actually scored on", () => {
    // Wanting a high value on axis 0, and this film delivers it.
    const reasons = reasonsFor(onAxis(0, 1), onAxis(0, 2), 1);
    expect(reasons).toEqual(["heavy"]);
  });

  it("uses the low label when the mood points downward", () => {
    // Wanting a *low* value on axis 0, and this film is low.
    const reasons = reasonsFor(onAxis(0, -1), onAxis(0, -2), 1);
    expect(reasons).toEqual(["light"]);
  });

  it("ignores axes that dragged the score down", () => {
    const w = [1, 1, ...new Array(MOOD_DIM - 2).fill(0)];
    const movie = [2, -2, ...new Array(MOOD_DIM - 2).fill(0)];
    // Axis 1 contributes negatively, so it is not a reason to watch it.
    expect(reasonsFor(w, movie, 2)).toEqual(["heavy"]);
  });

  it("returns nothing when the mood is flat", () => {
    expect(reasonsFor(new Array(MOOD_DIM).fill(0), onAxis(0, 3))).toEqual([]);
  });
});

describe("selectRecommendations", () => {
  const w = onAxis(0, 1);

  it("never repeats a director while alternatives remain", () => {
    // The four highest scorers are all by one director.
    const candidates = [
      film(1, "A", "Tarkovsky", onAxis(0, 9)),
      film(2, "B", "Tarkovsky", onAxis(0, 8.9)),
      film(3, "C", "Tarkovsky", onAxis(0, 8.8)),
      film(4, "D", "Kurosawa", onAxis(0, 5)),
      film(5, "E", "Fellini", onAxis(0, 4)),
      film(6, "F", "Bergman", onAxis(0, 3)),
    ];
    const picks = selectRecommendations(candidates, w, { count: 3 });
    const directors = picks.map((p) => p.movie.director);
    expect(new Set(directors).size).toBe(3);
    // The single best film should still lead.
    expect(picks[0].movie.id).toBe(1);
  });

  it("never repeats a franchise while alternatives remain", () => {
    const candidates = [
      film(1, "Rocky", "A", onAxis(0, 9)),
      film(2, "Rocky II", "B", onAxis(0, 8.9)),
      film(3, "Rocky III", "C", onAxis(0, 8.8)),
      film(4, "Heat", "D", onAxis(0, 5)),
      film(5, "Alien", "E", onAxis(0, 4)),
    ];
    const picks = selectRecommendations(candidates, w, { count: 3 });
    const titles = picks.map((p) => p.movie.title);
    expect(titles.filter((t) => t.startsWith("Rocky"))).toHaveLength(1);
  });

  it("prefers a film unlike what it has already picked", () => {
    // Two clusters: axis 0 and axis 1. Scores favour cluster 0 slightly.
    const candidates = [
      film(1, "A", "A", onAxis(0, 9)),
      film(2, "B", "B", onAxis(0, 8.5)),
      film(3, "C", "C", onAxis(1, 3)),
    ];
    // Pure relevance would take A then B; diversity should reach for C.
    const greedy = selectRecommendations(candidates, w, { count: 2, diversity: 0 });
    const diverse = selectRecommendations(candidates, w, { count: 2, diversity: 0.9 });
    expect(greedy.map((p) => p.movie.id)).toEqual([1, 2]);
    expect(diverse[0].movie.id).toBe(1);
    expect(diverse[1].movie.id).toBe(3);
  });

  it("relaxes the constraints rather than returning too few", () => {
    // Everything is by one director, so the rule cannot be honoured.
    const candidates = [
      film(1, "A", "Solo", onAxis(0, 9)),
      film(2, "B", "Solo", onAxis(0, 8)),
      film(3, "C", "Solo", onAxis(0, 7)),
    ];
    expect(selectRecommendations(candidates, w, { count: 3 })).toHaveLength(3);
  });

  it("returns everything available when the shortlist is short", () => {
    const candidates = [film(1, "A", "A", onAxis(0, 5))];
    expect(selectRecommendations(candidates, w, { count: 5 })).toHaveLength(1);
    expect(selectRecommendations([], w, { count: 5 })).toEqual([]);
  });

  it("attaches a reason to every pick", () => {
    const candidates = [
      film(1, "A", "A", onAxis(0, 9)),
      film(2, "B", "B", onAxis(0, 6)),
    ];
    for (const pick of selectRecommendations(candidates, w, { count: 2 })) {
      expect(pick.reasons.length).toBeGreaterThan(0);
    }
  });
});
