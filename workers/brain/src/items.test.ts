import { describe, expect, it } from "vitest";
import type { NoteSummary } from "./brain";
import { agenda, agendaSections, filterEvents, filterTasks, renderItems } from "./items";

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

describe("agenda", () => {
  const today = "2026-11-18";
  const tasks = [
    note("due-friday", { due: "2026-11-20" }),
    note("overdue", { due: "2026-11-16" }),
    note("next-month", { due: "2026-12-20" }),
    note("long-overdue", { due: "2026-10-20" }),
    note("untouched", {}, "2026-10-01T09:00:00Z"),
    note("fresh", {}, "2026-11-17T09:00:00Z"),
    note("ticked", { status: "done", due: "2026-11-19" }),
  ];
  const events = [note("this-week", { start: "2026-11-21T19:30" }), note("far-off", { start: "2026-12-25" })];

  it("says what's due or overdue, what's on this week and what's gone quiet", () => {
    const { due, coming, quiet } = agenda(tasks, events, today);
    expect(due).toEqual(["- tasks/overdue.md: overdue. Due 2026-11-16. Overdue.", "- tasks/due-friday.md: due-friday. Due 2026-11-20."]);
    expect(coming).toEqual(["- tasks/this-week.md: this-week. When: 2026-11-21 at 19:30."]);
    expect(quiet).toEqual(["- tasks/long-overdue.md: long-overdue. Due 2026-10-20.", "- tasks/untouched.md: untouched."]);
  });

  it("leaves out a list with nothing in it", () => {
    expect(agendaSections({ due: [], coming: ["- one"], quiet: [] })).toEqual([{ title: "Events in the next week", body: "- one" }]);
  });
});
