import type { NoteSummary, NoteView } from "./brain";

export const MAX_LISTED_ITEMS = 50;
const MAX_UNFILED_LISTED = 10;
const MAX_UNFILED_CHARS = 200;
const MAX_NOTE_CHARS = 8_000;

export interface TaskFilter {
  status?: "open" | "done" | "dropped";
  area?: "work" | "personal";
  due_by?: string;
}

export interface EventFilter {
  from?: string;
  to?: string;
  area?: "work" | "personal";
}

const field = (note: NoteSummary, key: string) => (typeof note.fields[key] === "string" ? (note.fields[key] as string) : "");
const IMPORTANCE_ORDER: Record<string, number> = { high: 0, normal: 1, "": 1, low: 2 };

/** The to-dos that match, dated ones first by due day, then by how much they matter, then newest. */
export function filterTasks(notes: NoteSummary[], { status = "open", area, due_by }: TaskFilter): NoteSummary[] {
  return notes
    .filter((note) => (field(note, "status") || "open") === status)
    .filter((note) => !area || field(note, "area") === area)
    .filter((note) => !due_by || (field(note, "due") !== "" && field(note, "due") <= due_by))
    .sort(
      (a, b) =>
        (field(a, "due") || "9999").localeCompare(field(b, "due") || "9999") ||
        IMPORTANCE_ORDER[field(a, "importance")]! - IMPORTANCE_ORDER[field(b, "importance")]! ||
        b.updated_at.localeCompare(a.updated_at),
    );
}

/** The events still on between two days, soonest first. `from` defaults to today. */
export function filterEvents(notes: NoteSummary[], { from, to, area }: EventFilter, today: string): NoteSummary[] {
  const first = from ?? today;
  return notes
    .filter((note) => (field(note, "status") || "open") === "open")
    .filter((note) => !area || field(note, "area") === area)
    .filter((note) => field(note, "start").slice(0, 10) >= first && (!to || field(note, "start").slice(0, 10) <= to))
    .sort((a, b) => field(a, "start").localeCompare(field(b, "start")));
}

export function itemLine(note: NoteSummary): string {
  const people = Array.isArray(note.fields.people) ? note.fields.people.join(", ") : "";
  const parts = [
    note.title,
    field(note, "start") && `When: ${field(note, "start").replace("T", " at ")}`,
    field(note, "due") && `Due ${field(note, "due")}`,
    field(note, "location") && `Where: ${field(note, "location")}`,
    people && `Who: ${people}`,
    field(note, "importance") === "high" && "Matters a lot",
    field(note, "area"),
  ];
  return `- ${note.path}: ${parts.filter(Boolean).join(". ")}.`;
}

/** What `list_tasks` and `list_events` hand back: one line per item with its path, then anything captured that isn't filed yet. */
export function renderItems(heading: string, none: string, notes: NoteSummary[], unfiled: string[], today: string): string {
  const shown = notes.slice(0, MAX_LISTED_ITEMS);
  const list = shown.length ? [`${heading} Today is ${today}.`, ...shown.map(itemLine), ...(notes.length > shown.length ? [`And ${notes.length - shown.length} more.`] : [])].join("\n") : `${none} Today is ${today}.`;
  if (!unfiled.length) return list;
  const waiting = unfiled.slice(-MAX_UNFILED_LISTED).map((text) => `- ${text.replaceAll("\n", " ").slice(0, MAX_UNFILED_CHARS)}`);
  return `${list}\n\nCaptured but not filed yet, so there may be more in here:\n${waiting.join("\n")}`;
}

/** What `read_note` hands back: the note's fields, its body and what links to it. */
export function renderNote(note: NoteView): string {
  const fields = Object.entries(note.fields).filter(([, value]) => !Array.isArray(value) || value.length);
  const body = note.body.length > MAX_NOTE_CHARS ? `${note.body.slice(0, MAX_NOTE_CHARS)}\n[cut short]` : note.body.trim();
  return [
    `## ${note.path}`,
    fields.length ? fields.map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`).join("\n") : "",
    body,
    note.linked_from.length ? `Linked from: ${note.linked_from.map((path) => `[[${path.replace(/\.md$/, "")}]]`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the brief says is pressing, so nobody has to ask for the list to hear about it. */
export interface Agenda {
  /** Open to-dos due within a week, or overdue by less than a fortnight. */
  due: string[];
  /** Events in the next week. */
  coming: string[];
  /** Open to-dos nobody has touched in a month, or that are more than a fortnight overdue. */
  quiet: string[];
}

const SOON_DAYS = 7;
const LONG_OVERDUE_DAYS = 14;
const QUIET_DAYS = 30;
const MAX_AGENDA_LINES = 10;

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function agenda(tasks: NoteSummary[], events: NoteSummary[], today: string): Agenda {
  const open = filterTasks(tasks, {});
  const goneQuiet = (note: NoteSummary) => (field(note, "due") ? field(note, "due") < addDays(today, -LONG_OVERDUE_DAYS) : note.updated_at.slice(0, 10) < addDays(today, -QUIET_DAYS));
  const pressing = open.filter((note) => field(note, "due") !== "" && field(note, "due") <= addDays(today, SOON_DAYS) && !goneQuiet(note));
  return {
    due: pressing.slice(0, MAX_AGENDA_LINES).map((note) => `${itemLine(note)}${field(note, "due") < today ? " Overdue." : ""}`),
    coming: filterEvents(events, { to: addDays(today, SOON_DAYS) }, today).slice(0, MAX_AGENDA_LINES).map(itemLine),
    quiet: open.filter(goneQuiet).slice(0, MAX_AGENDA_LINES).map(itemLine),
  };
}

/** The agenda as titled lists, leaving out any that are empty. */
export function agendaSections({ due, coming, quiet }: Agenda): { title: string; body: string }[] {
  const sections = [
    { title: "To-dos due this week or overdue", lines: due },
    { title: "Events in the next week", lines: coming },
    { title: "To-dos that have gone quiet", lines: quiet },
  ];
  return sections.filter((s) => s.lines.length).map((s) => ({ title: s.title, body: s.lines.join("\n") }));
}
