import { describe, expect, it } from "vitest";
import { extractPlot } from "./02-fetch-plots";

/** Shape of a real plain-text extract from the MediaWiki extracts API. */
function article(sections: Array<[string, string]>, lead = "A 2015 film."): string {
  return (
    lead +
    "\n\n" +
    sections.map(([heading, body]) => `== ${heading} ==\n\n${body}`).join("\n\n\n")
  );
}

const LONG = "The protagonist drives across the desert and everything explodes. ".repeat(6);

describe("extractPlot", () => {
  it("pulls out the Plot section and nothing else", () => {
    const text = article([
      ["Plot", LONG],
      ["Cast", "Someone as Someone."],
      ["Production", "Filmed in Namibia."],
    ]);
    const plot = extractPlot(text);
    expect(plot).toContain("drives across the desert");
    expect(plot).not.toContain("Filmed in Namibia");
    expect(plot).not.toContain("Someone as Someone");
  });

  it("stops at the next heading of any level", () => {
    const text =
      article([["Plot", LONG]]) + "\n\n=== A subsection ===\n\nThis must not be included.";
    expect(extractPlot(text)).not.toContain("must not be included");
  });

  it("accepts the alternative headings articles actually use", () => {
    for (const heading of ["Synopsis", "Plot summary", "Story", "Premise"]) {
      const plot = extractPlot(article([[heading, LONG], ["Cast", "x"]]));
      expect(plot, `heading: ${heading}`).toContain("drives across the desert");
    }
  });

  it("is case-insensitive about the heading", () => {
    expect(extractPlot(article([["PLOT", LONG]]))).toContain("drives across the desert");
  });

  it("falls back to the lead when there is no plot section", () => {
    // Documentaries frequently have no Plot section at all, so this path is
    // load-bearing rather than defensive.
    const lead =
      "Some Documentary is a 2015 British documentary film about competitive cheese rolling " +
      "in Gloucestershire, directed by someone notable and photographed over three summers. " +
      "It premiered at a festival and was praised for its warmth and gentle humour.";
    const text = article([["Reception", "Critics were kind."]], lead);
    const plot = extractPlot(text);
    expect(plot).toContain("cheese rolling");
    // The heading that follows the lead must not be dragged in with it.
    expect(plot).not.toContain("==");
    expect(plot).not.toContain("Critics were kind");
  });

  it("returns null when there is nothing substantial to use", () => {
    expect(extractPlot("")).toBeNull();
    expect(extractPlot("   ")).toBeNull();
    expect(extractPlot("A film.")).toBeNull();
  });

  it("ignores a plot section too short to be a real summary", () => {
    // A stub plot section should not win over a usable lead.
    const lead =
      "Some Film is a 1962 British drama directed by a person of note, concerning a long journey " +
      "across country by train, with much incident along the way. It was among the first films of " +
      "its kind to be shot entirely on location.";
    const text = article([["Plot", "TBD."]], lead);
    expect(extractPlot(text)).toContain("long journey");
  });

  it("caps the returned length so batch scoring costs stay bounded", () => {
    const plot = extractPlot(article([["Plot", "word ".repeat(5000)]]));
    expect(plot!.length).toBeLessThanOrEqual(4000);
  });
});
