import { describe, expect, it } from "vitest";
import { nameSimilarity, normaliseName, rankMatches } from "./matching";

const master = ["Panadol 500mg", "Panadol Extra", "Augmentin 625mg", "Augmentin 1g", "Brufen 400mg", "Brufen Syrup 100mg/5ml", "Risek 20mg", "Risek 40mg"];

describe("item name matching", () => {
  it("reads names the way shops type them", () => {
    expect(normaliseName("PANADOL TAB 500 MG")).toEqual(["panadol", "500mg"]);
    expect(normaliseName("Brufen Syp. 100mg/5ml")).toEqual(["brufen", "syrup", "100mg", "5ml"]);
  });

  it("treats spelling variants as the same and different strengths as different", () => {
    expect(nameSimilarity("PANADOL TAB 500 MG", "Panadol 500mg")).toBe(1);
    expect(nameSimilarity("Augmentin 625", "Augmentin 625mg")).toBeGreaterThan(0.7);
    expect(nameSimilarity("Augmentin 625mg", "Augmentin 1g")).toBeLessThanOrEqual(0.5);
    expect(nameSimilarity("Risek 20", "Risek 40mg")).toBeLessThanOrEqual(0.5);
  });

  it("takes a clear match, asks about a close call, and finds nothing for an unknown item", () => {
    expect(rankMatches("panadol tablets 500 mg", master, (name) => name)).toMatchObject({ verdict: "matched", candidates: [{ item: "Panadol 500mg", score: 1 }] });
    // "Panadol" alone could be either Panadol; a person decides.
    const panadol = rankMatches("Panadol", master, (name) => name);
    expect(panadol.verdict).toBe("review");
    expect(panadol.candidates.map((candidate) => candidate.item)).toEqual(expect.arrayContaining(["Panadol 500mg", "Panadol Extra"]));
    expect(rankMatches("Brufen 400", master, (name) => name).candidates[0].item).toBe("Brufen 400mg");
    expect(rankMatches("Surbex Z", master, (name) => name)).toEqual({ verdict: "none", candidates: [] });
  });
});
