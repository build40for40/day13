import { describe, expect, it } from "vitest";
import { renderRecall, search } from "./recall";

const notes = [
  { path: "USER.md", body: "# About me\n\n- Has a fake dog called Biscuit\n" },
  { path: "sessions/2026-11-10-aaaaaaaa.md", body: "# Conversation\n\nTalked about the fake dog and fake trains.\n" },
  { path: "reference/about.md", body: "# About\n\nOpening hours are made up.\n" },
];

describe("search", () => {
  it("returns the notes that mention the most words of the query, best first", () => {
    expect(search(notes, "Fake TRAINS and the dog").map((n) => n.path)).toEqual(["sessions/2026-11-10-aaaaaaaa.md", "USER.md"]);
    expect(search(notes, "opening hours").map((n) => n.path)).toEqual(["reference/about.md"]);
  });

  it("matches a note by its path, and stops at the limit", () => {
    expect(search(notes, "sessions").map((n) => n.path)).toEqual(["sessions/2026-11-10-aaaaaaaa.md"]);
    expect(search(notes, "fake about", 1)).toHaveLength(1);
  });

  it("finds nothing for words that aren't there or a query with no real words", () => {
    expect(search(notes, "submarine")).toEqual([]);
    expect(search(notes, "a ?? to")).toEqual([]);
  });
});

describe("renderRecall", () => {
  it("shows each note under its path, cuts a long one short and says when there's nothing", () => {
    expect(renderRecall([notes[2]])).toBe("## reference/about.md\n# About\n\nOpening hours are made up.");
    expect(renderRecall([{ path: "long.md", body: "x".repeat(2_000) }])).toBe(`## long.md\n${"x".repeat(1_500)}\n[cut short]`);
    expect(renderRecall([])).toBe("Nothing in your notes matches that.");
  });
});
