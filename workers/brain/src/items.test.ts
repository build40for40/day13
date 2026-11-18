import { describe, expect, it } from "vitest";
import type { NoteSummary } from "./brain";
import { filterEvents, filterTasks, renderItems } from "./items";

const note = (title: string, fields: Record<string, unknown> = {}, updated_at = "2026-11-18T09:00:00Z"): NoteSummary => ({ path: `tasks/${title}.md`, kind: "task", title, updated_at, fields: { status: "open", ...fields } });
const titles = (notes: NoteSummary[]) => notes.map((n) => n.title);

describe("filterTasks", () => {
  const tasks = [
    note("undated-low", { importance: "low" }),
    note("undated-high", { importance: "high", area: "work" }),
    note("later", { due: "2026-11-30", area: "work" }),
    note("sooner", { due: "2026-11-20" }),
    note("ticked", { status: "done", due: "2026-11-19" }),
    note("undated-newer", {}, "2026-11-18T10:00:00Z"),
  ];

  it("lists open to-dos by due day, then by how much they matter, then newest", () => {
    expect(titles(filterTasks(tasks, {}))).toEqual(["sooner", "later", "undated-high", "undated-newer", "undated-low"]);
  });

  it("narrows by status, area and a latest due day", () => {
    expect(titles(filterTasks(tasks, { status: "done" }))).toEqual(["ticked"]);
    expect(titles(filterTasks(tasks, { area: "work" }))).toEqual(["later", "undated-high"]);
    expect(titles(filterTasks(tasks, { due_by: "2026-11-20" }))).toEqual(["sooner"]);
  });
});

describe("filterEvents", () => {
  const events = [
    note("next-week", { start: "2026-11-25T19:30" }),
    note("today", { start: "2026-11-18", area: "work" }),
    note("yesterday", { start: "2026-11-17" }),
    note("cancelled", { start: "2026-11-19", status: "dropped" }),
  ];

  it("lists what's still on from today, soonest first", () => {
    expect(titles(filterEvents(events, {}, "2026-11-18"))).toEqual(["today", "next-week"]);
  });

  it("narrows by days and area", () => {
    expect(titles(filterEvents(events, { from: "2026-11-17", to: "2026-11-18" }, "2026-11-18"))).toEqual(["yesterday", "today"]);
    expect(titles(filterEvents(events, { area: "work" }, "2026-11-18"))).toEqual(["today"]);
  });
});

describe("renderItems", () => {
  it("says the day, and when nothing matches", () => {
    expect(renderItems("Their open to-dos.", "No open to-dos match.", [], [], "2026-11-18")).toBe("No open to-dos match. Today is 2026-11-18.");
    expect(renderItems("Their open to-dos.", "None.", [note("fake", { due: "2026-11-20", importance: "high" })], [], "2026-11-18")).toBe("Their open to-dos. Today is 2026-11-18.\n- tasks/fake.md: fake. Due 2026-11-20. Matters a lot.");
  });
});
