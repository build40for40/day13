import type { JsonValue } from "./profile";
import { USER_MD } from "./profile";
import type { DumpItem, ItemKind, PageNote, Reflection } from "./reflection";
import { linkKind, parseWikilinks, wikilink } from "./wikilinks";

export type NoteKind = "user" | "memory" | "session" | ItemKind | "topic" | "person";

export const NOTE_KINDS: readonly NoteKind[] = ["user", "memory", "session", "idea", "question", "task", "event", "note", "thought", "topic", "person"];

const ITEM_FOLDERS: Record<ItemKind, string> = { idea: "ideas", question: "questions", task: "tasks", event: "events", note: "notes", thought: "thoughts" };
const MAX_SLUG = 60;

type Frontmatter = { [key: string]: JsonValue };

interface FileRow extends Record<string, SqlStorageValue> {
  path: string;
  kind: string;
  frontmatter: string;
  body: string;
}

export interface ReflectedSession {
  id: string;
  started_at: string;
  reflection: Reflection;
}

/** What the assistant has learned, as plain lines without bullets or session links. */
export interface Learned {
  facts: string[];
  lessons: string[];
}

export interface NoteVersion {
  id: number;
  path: string;
  operation: "created" | "modified" | "deleted";
  /** Who wrote it: `seed`, `session:<id>`, `consolidation` or `restore:<version id>`. */
  actor: string;
  at: string;
}

/** The heading in a topic note that lists the items filed under it. */
export const FILED = "Filed";

/** The heading in a topic or person note that says where things stand. Rewritten whenever something new is filed there. */
export const SUMMARY = "Summary";

/** The heading in USER.md that the reflection writes under. The user's own text sits outside it and is never touched. */
export const LEARNED = "Learned in conversation";

export const MEMORY_MD = "MEMORY.md";
/** The heading in MEMORY.md that the reflection writes under. */
export const LESSONS = "Lessons";
const MEMORY_START = "# Memory\n";

/** Older versions of a note than this are dropped. */
export const MAX_VERSIONS_PER_NOTE = 50;

export const londonDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(iso));
export const londonTime = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
export const londonDay = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));

/** When the London day that `iso` falls in ends. It can be an hour out on the two days the clocks change, so callers compare dates as well. */
export function nextLondonMidnight(iso: string): string {
  const at = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = (part("hour") * 3600 + part("minute") * 60 + part("second")) * 1000 + at.getMilliseconds();
  return new Date(at.getTime() + 24 * 3600 * 1000 - elapsed).toISOString();
}

export function sessionNotePath(session: Pick<ReflectedSession, "id" | "started_at">): string {
  return `sessions/${londonDate(session.started_at)}-${session.id.slice(0, 8)}.md`;
}

export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export const topicPath = (topic: string) => `topics/${slugify(topic)}.md`;
/** "the kids" and "kids" are the same page. */
export const personPath = (name: string) => `people/${slugify(name.replace(/^the\s+/i, ""))}.md`;

type Area = "work" | "personal" | "mixed";

/** A page's area is worked out from what's filed on it: one area, or mixed once it holds both. */
export function mergeArea(current: JsonValue | undefined, areas: string[]): Area | undefined {
  const seen = new Set<string>([...(current === "mixed" ? ["work", "personal"] : typeof current === "string" ? [current] : []), ...areas].filter((a) => a === "work" || a === "personal"));
  return seen.size > 1 ? "mixed" : ([...seen][0] as Area | undefined);
}

/** Puts a summary at the top of a topic or person note, above everything filed there. */
export function withSummary(body: string, summary: string): string {
  if (!summary) return body;
  const lines = body.replace(/\s+$/, "").split("\n");
  if (lines.includes(`## ${SUMMARY}`)) return editSection(body, SUMMARY, () => [summary]);
  const at = lines.findIndex((line) => line.startsWith("## "));
  const head = (at === -1 ? lines : lines.slice(0, at)).join("\n").replace(/\s+$/, "");
  const rest = at === -1 ? "" : lines.slice(at).join("\n");
  return `${[head, `## ${SUMMARY}\n\n${summary}`, rest].filter(Boolean).join("\n\n")}\n`;
}

/** The summary a topic or person note opens with, or nothing when it has none yet. */
export const summaryOf = (body: string) => sectionLines(body, SUMMARY).join(" ");

interface Filing {
  kind: "topic" | "person";
  path: string;
  name: string;
  /** The lines to list under Filed, replacing any that hold `key`. */
  lines: string[];
  key: string;
  areas: string[];
  page?: PageNote;
}

/** Lists items on a topic or person's page, creating it when it's new, and brings its summary and area up to date in the same version. */
function fileOnPage(sql: SqlStorage, { kind, path, name, lines, key, areas, page }: Filing, now: string, actor: string): void {
  const current = readFile(sql, path);
  const frontmatter: Frontmatter = { ...(current?.frontmatter ?? (kind === "topic" ? { topic: name } : { name })) };
  const area = mergeArea(frontmatter.area, areas);
  if (area) frontmatter.area = area;
  if (kind === "topic" && page) frontmatter.type = page.project ? "project" : "topic";
  const filed = editSection(current?.body ?? `# ${name}\n`, FILED, replaceSessionLines(key, lines));
  writeFile(sql, path, kind, frontmatter, withSummary(filed, page?.summary ?? ""), now, actor);
}

/** The first heading of a note, or its path when it has none. */
export function noteTitle(path: string, body: string): string {
  return body.match(/^# (.+)$/m)?.[1].trim() ?? path;
}

/** Rewrites the list under `## heading`, adding the section at the end when it's missing and dropping it when it ends up empty. */
export function editSection(body: string, heading: string, edit: (lines: string[]) => string[]): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const start = lines.indexOf(`## ${heading}`);
  const end = start === -1 ? lines.length : nextHeading(lines, start + 1);
  const current = start === -1 ? [] : lines.slice(start + 1, end).filter((l) => l.trim());
  const next = edit(current);
  const before = (start === -1 ? lines : lines.slice(0, start)).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n").replace(/\s+$/, "");
  const section = next.length ? `## ${heading}\n\n${next.join("\n")}` : "";
  return `${[before, section, after].filter(Boolean).join("\n\n")}\n`;
}

/** Swaps one session's lines for new ones, leaving every other session's lines alone. */
export const replaceSessionLines = (key: string, lines: string[]) => (current: string[]) => [...current.filter((l) => !l.includes(key)), ...lines];

/** Adds the lines that aren't there yet. */
export const addLines = (lines: string[]) => (current: string[]) => [...new Set([...current, ...lines])];

interface Filed {
  path: string;
  kind: string;
  title: string;
  topics: string[];
  people: string[];
  area: string;
}

/**
 * Writes everything one reflection learned into the vault, then rebuilds the links. Running it again with the same input changes nothing:
 * every line a session adds carries that session's [[wikilink]], and a rerun replaces that session's lines. A rerun with different
 * items also removes the notes and topic lines the earlier run left that are no longer wanted, except notes the person has changed
 * since, which are left exactly as they are. A draft leaves USER.md and MEMORY.md alone.
 */
export function writeReflection(sql: SqlStorage, session: ReflectedSession, now: string, { draft = false }: { draft?: boolean } = {}): string {
  const { reflection } = session;
  const actor = `session:${session.id}`;
  const sessionPath = sessionNotePath(session);
  const sessionLink = wikilink(sessionPath);

  const before = sessionItems(sql, session.id);
  const kept = before.filter((note) => !onlyWrittenBy(sql, note.path, actor));
  const claimed = new Set(kept.map((note) => note.path));
  const written: Filed[] = reflection.items.flatMap((item) => {
    const path = writeItem(sql, session, item, now, claimed);
    return path ? [{ path, kind: item.kind, title: item.title, topics: item.topics, people: item.people, area: item.area }] : [];
  });
  const filed = [...written, ...kept];
  const wanted = new Set(filed.map((note) => note.path));
  for (const note of before) if (!wanted.has(note.path)) deleteFile(sql, note.path, now, actor);

  writeFile(sql, sessionPath, "session", { session_id: session.id, date: londonDate(session.started_at) }, sessionBody(session, filed), now, actor);

  const pageFor = (kind: PageNote["kind"], name: string) => reflection.pages?.find((page) => page.kind === kind && page.name === name);
  const filing = (kind: Filing["kind"], path: string, name: string, on: Filed[]): Filing => ({
    kind,
    path,
    name,
    lines: on.map((note) => `- ${wikilink(note.path, note.title)} (${sessionLink})`),
    key: sessionLink,
    areas: on.map((note) => note.area),
    page: pageFor(kind, name),
  });
  const place = (page: Filing) => {
    const current = readFile(sql, page.path);
    const emptied = current && !page.lines.length && !sectionLines(editSection(current.body, FILED, replaceSessionLines(page.key, [])), FILED).length;
    if (emptied && onlyWrittenBy(sql, page.path, actor)) deleteFile(sql, page.path, now, actor);
    else fileOnPage(sql, page, now, actor);
  };
  const holding = sql.exec<FileRow>("SELECT path, kind, frontmatter, body FROM files WHERE kind IN ('topic', 'person') AND instr(body, ?) > 0", sessionLink).toArray();
  const named = (kind: Filing["kind"], key: "topic" | "name") => holding.flatMap((row) => (row.kind === kind ? [[row.path, String((JSON.parse(row.frontmatter) as Frontmatter)[key] ?? noteTitle(row.path, row.body))] as const] : []));
  const topics = new Map([...named("topic", "topic"), ...filed.flatMap((note) => note.topics).map((topic) => [topicPath(topic), topic] as const)]);
  for (const [path, topic] of topics) {
    place(filing("topic", path, topic, filed.filter((note) => note.topics.some((t) => topicPath(t) === path))));
  }
  for (const [path, name] of new Map([...named("person", "name"), ...peoplePages(filed)])) {
    place(filing("person", path, name, filed.filter((note) => note.people.some((person) => personPath(person) === path))));
  }

  if (!draft) {
    const user = readFile(sql, USER_MD);
    if (user) {
      writeFile(sql, USER_MD, "user", user.frontmatter, editSection(user.body, LEARNED, sessionEntries(sessionLink, reflection.facts)), now, actor);
    }

    const memory = readFile(sql, MEMORY_MD);
    if (memory || reflection.lessons.length) {
      const body = editSection(memory?.body ?? MEMORY_START, LESSONS, sessionEntries(sessionLink, reflection.lessons));
      writeFile(sql, MEMORY_MD, "memory", memory?.frontmatter ?? {}, body, now, actor);
    }
  }

  rebuildLinks(sql);
  return sessionPath;
}

/** The item notes one session has filed, and for each whether the person has changed it since. */
export function filedBy(sql: SqlStorage, sessionId: string): { kind: string; title: string; changed: boolean }[] {
  return sessionItems(sql, sessionId).map(({ path, kind, title }) => ({ kind, title, changed: !onlyWrittenBy(sql, path, `session:${sessionId}`) }));
}

function sessionItems(sql: SqlStorage, sessionId: string): Filed[] {
  const kinds = Object.keys(ITEM_FOLDERS).map((kind) => `'${kind}'`).join(", ");
  return sql
    .exec<FileRow>(`SELECT path, kind, frontmatter, body FROM files WHERE kind IN (${kinds}) AND json_extract(frontmatter, '$.session_id') = ? ORDER BY path`, sessionId)
    .toArray()
    .map((row) => {
      const frontmatter = JSON.parse(row.frontmatter) as Frontmatter;
      const strings = (value: JsonValue | undefined) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
      return { path: row.path, kind: row.kind, title: noteTitle(row.path, row.body), topics: strings(frontmatter.topics), people: strings(frontmatter.people), area: typeof frontmatter.area === "string" ? frontmatter.area : "" };
    });
}

function onlyWrittenBy(sql: SqlStorage, path: string, actor: string): boolean {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM file_versions WHERE path = ? AND actor != ?", path, actor).one().n === 0;
}

/** What has been learned so far, for the consolidation to tidy. */
export function readLearned(sql: SqlStorage): Learned {
  return {
    facts: sectionLines(readFile(sql, USER_MD)?.body ?? "", LEARNED).map(entryText),
    lessons: sectionLines(readFile(sql, MEMORY_MD)?.body ?? "", LESSONS).map(entryText),
  };
}

/**
 * Swaps both learned sections for the consolidated lines. The lines lose their session links: where each one came from is
 * in the versions of the note, which is also the way back if a consolidation drops something it shouldn't have.
 */
export function writeConsolidation(sql: SqlStorage, learned: Learned, now: string): void {
  const bullets = (items: string[]) => () => items.map((item) => `- ${item}`);
  const user = readFile(sql, USER_MD);
  if (user) writeFile(sql, USER_MD, "user", user.frontmatter, editSection(user.body, LEARNED, bullets(learned.facts)), now, "consolidation");
  const memory = readFile(sql, MEMORY_MD);
  if (memory || learned.lessons.length) {
    writeFile(sql, MEMORY_MD, "memory", memory?.frontmatter ?? {}, editSection(memory?.body ?? MEMORY_START, LESSONS, bullets(learned.lessons)), now, "consolidation");
  }
  rebuildLinks(sql);
}

/** Throws away the links table and reads it back from every note's [[wikilinks]], so it can never drift from the notes. */
export function rebuildLinks(sql: SqlStorage): void {
  sql.exec("DELETE FROM links");
  for (const { path, body } of sql.exec<FileRow>("SELECT path, body FROM files ORDER BY path").toArray()) {
    for (const dst of parseWikilinks(body)) {
      if (dst !== path) sql.exec("INSERT OR IGNORE INTO links (src, dst, kind) VALUES (?, ?, ?)", path, dst, linkKind(dst));
    }
  }
}

/** Swaps one session's entries for new ones, skipping any that another session already left. */
function sessionEntries(sessionLink: string, entries: string[]) {
  return (current: string[]) => {
    const others = current.filter((l) => !l.includes(sessionLink));
    const known = new Set(others.map(preferenceText));
    return [...others, ...entries.filter((e) => !known.has(e.toLowerCase())).map((e) => `- ${e} (${sessionLink})`)];
  };
}

/** One page per person, under the first name they were given, so "the kids" and "Kids" don't make two. */
function peoplePages(items: { people: string[] }[]): Map<string, string> {
  const pages = new Map<string, string>();
  for (const name of items.flatMap((item) => item.people)) if (!pages.has(personPath(name))) pages.set(personPath(name), name);
  return pages;
}

/** The line in an item's body that says when, where and who, so recall finds them. `link` points each person at their page. */
export function fieldsLine(fields: { due?: JsonValue; start?: JsonValue; location?: JsonValue; people?: JsonValue }, link = false): string {
  const people = (Array.isArray(fields.people) ? fields.people : []).map((person) => (link ? wikilink(personPath(String(person)), String(person)) : String(person)));
  return [fields.due ? `Due ${fields.due}.` : "", fields.start ? `When: ${fields.start}.` : "", fields.location ? `Where: ${fields.location}.` : "", people.length ? `Who: ${people.join(", ")}.` : ""].filter(Boolean).join(" ");
}

const FIELDS_LINE = /^(Due \d{4}-\d{2}-\d{2}\.|When: \d{4}-\d{2}-\d{2}|Where: |Who: )/;
const AFTER_FIELDS = /^(## |Filed under \[\[|From \[\[)/;

/** Swaps the fields line of a task or event's body for a new one, adding it after the detail when there wasn't one. */
export function withFieldsLine(body: string, line: string): string {
  const blocks = body.trimEnd().split("\n\n");
  const at = blocks.findIndex((block, i) => i > 0 && FIELDS_LINE.test(block));
  if (at !== -1) blocks.splice(at, 1, ...(line ? [line] : []));
  else if (line) {
    const before = blocks.findIndex((block, i) => i > 0 && AFTER_FIELDS.test(block));
    blocks.splice(before === -1 ? blocks.length : before, 0, line);
  }
  return `${blocks.join("\n\n")}\n`;
}

function itemFrontmatter(item: DumpItem, origin: Frontmatter): Frontmatter {
  const fields: Frontmatter = { area: item.area, due: item.due, start: item.start, location: item.location, importance: item.importance };
  const present = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== "" && v !== undefined));
  const frontmatter: Frontmatter = { kind: item.kind, ...origin, topics: item.topics, ...(present as Frontmatter) };
  if (item.kind === "task" || item.kind === "event") frontmatter.status = "open";
  if (item.people.length) frontmatter.people = item.people;
  if (item.inferred.length) frontmatter.inferred = item.inferred;
  return frontmatter;
}

/** Files a task or event the moment it's added, without waiting for a reflection. Returns its path. */
export function writeAddedItem(sql: SqlStorage, item: DumpItem, now: string, actor: string): string {
  const date = londonDate(now);
  const base = `${ITEM_FOLDERS[item.kind]}/${date}-${slugify(item.title)}`;
  let path = `${base}.md`;
  for (let n = 2; readFile(sql, path); n++) path = `${base}-${n}.md`;
  const body = [`# ${item.title}`, item.detail, fieldsLine(item, true)].filter(Boolean).join("\n\n").concat("\n");
  writeFile(sql, path, item.kind, itemFrontmatter(item, { date, added_by: actor }), body, now, actor);
  const link = wikilink(path, item.title);
  for (const [page, name] of peoplePages([item])) {
    fileOnPage(sql, { kind: "person", path: page, name, lines: [`- ${link}`], key: `[[${path.replace(/\.md$/, "")}|`, areas: [item.area] }, now, actor);
  }
  if (item.people.length) rebuildLinks(sql);
  return path;
}

/**
 * Writes one dumped item as its own note and returns its path. The path comes from the London day and the title, with a
 * number added when another session already has that path, so a rerun of the same session lands on the same note.
 * Returns null, writing nothing, when that note is one the person has changed since this session filed it.
 */
function writeItem(sql: SqlStorage, session: ReflectedSession, item: DumpItem, now: string, claimed: Set<string>): string | null {
  const base = `${ITEM_FOLDERS[item.kind]}/${londonDate(session.started_at)}-${slugify(item.title)}`;
  const takenByAnother = (path: string) => {
    const current = readFile(sql, path);
    return current !== null && current.frontmatter.session_id !== session.id;
  };
  let path = `${base}.md`;
  if (claimed.has(path) && !onlyWrittenBy(sql, path, `session:${session.id}`)) return null;
  for (let n = 2; claimed.has(path) || takenByAnother(path); n++) path = `${base}-${n}.md`;
  claimed.add(path);
  const topics = item.topics.map((topic) => wikilink(topicPath(topic), topic));
  const body = [
    `# ${item.title}`,
    item.detail,
    fieldsLine(item, true),
    item.answer ? `## Answer\n\n${item.answer}` : "",
    [topics.length ? `Filed under ${topics.join(", ")}.` : "", `From ${wikilink(sessionNotePath(session))}.`].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
  writeFile(sql, path, item.kind, itemFrontmatter(item, { session_id: session.id, date: londonDate(session.started_at) }), body, now, `session:${session.id}`);
  return path;
}

function sessionBody({ started_at, reflection }: ReflectedSession, filed: Filed[]): string {
  const list = (heading: string, items: string[]) => (items.length ? `## ${heading}\n\n${items.map((i) => `- ${i}`).join("\n")}` : "");
  return [
    `# Conversation, ${londonDay(started_at)}`,
    reflection.summary,
    list(FILED, filed.map((note) => `${wikilink(note.path, note.title)} (${note.kind})`)),
    list("Learned about them", reflection.facts),
    list(LESSONS, reflection.lessons),
  ]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
}

function entryText(line: string): string {
  return line.replace(/^- /, "").replace(/ \(\[\[[^\]]*\]\]\)$/, "");
}

function preferenceText(line: string): string {
  return entryText(line).toLowerCase();
}

const hasLearned = (body: string) => body.split("\n").includes(`## ${LEARNED}`);
const withoutLearned = (body: string) => (hasLearned(body) ? editSection(body, LEARNED, () => []) : body);

/** Splits USER.md's body into the user's free text and the entries the assistant learned, without bullets or session links. */
export function splitLearned(body: string): { about: string; learned: string[] } {
  return { about: withoutLearned(body), learned: sectionLines(body, LEARNED).map(entryText) };
}

/** Replaces the free text of USER.md's body, keeping the learned section as it is. For when users can edit their own profile. */
export function replaceAbout(body: string, about: string): string {
  const learned = sectionLines(body, LEARNED);
  const free = withoutLearned(about);
  return learned.length ? editSection(free, LEARNED, () => learned) : free;
}

export function sectionLines(body: string, heading: string): string[] {
  let found: string[] = [];
  editSection(body, heading, (lines) => (found = lines));
  return found;
}

function nextHeading(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) if (/^#{1,2} /.test(lines[i])) return i;
  return lines.length;
}

export function readFile(sql: SqlStorage, path: string): { frontmatter: Frontmatter; body: string } | null {
  const row = sql.exec<FileRow>("SELECT path, kind, frontmatter, body FROM files WHERE path = ?", path).toArray()[0];
  return row ? { frontmatter: JSON.parse(row.frontmatter), body: row.body } : null;
}

/** Saves a note and keeps the version, leaving both untouched when nothing changed. */
export function writeFile(sql: SqlStorage, path: string, kind: NoteKind, frontmatter: Frontmatter, body: string, now: string, actor: string): void {
  const meta = JSON.stringify(frontmatter);
  const current = sql.exec<FileRow>("SELECT path, kind, frontmatter, body FROM files WHERE path = ?", path).toArray()[0];
  if (current && current.kind === kind && current.frontmatter === meta && current.body === body) return;
  sql.exec(
    `INSERT INTO files (path, kind, frontmatter, body, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (path) DO UPDATE SET kind = excluded.kind, frontmatter = excluded.frontmatter, body = excluded.body, updated_at = excluded.updated_at`,
    path,
    kind,
    meta,
    body,
    now,
  );
  sql.exec("INSERT INTO file_versions (path, operation, kind, frontmatter, body, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)", path, current ? "modified" : "created", kind, meta, body, actor, now);
  sql.exec("DELETE FROM file_versions WHERE path = ? AND id NOT IN (SELECT id FROM file_versions WHERE path = ? ORDER BY id DESC LIMIT ?)", path, path, MAX_VERSIONS_PER_NOTE);
}

/** Removes a note, keeping its last content as a version so it can be put back. */
export function deleteFile(sql: SqlStorage, path: string, now: string, actor: string): void {
  const current = sql.exec<FileRow>("SELECT path, kind, frontmatter, body FROM files WHERE path = ?", path).toArray()[0];
  if (!current) return;
  sql.exec("DELETE FROM files WHERE path = ?", path);
  sql.exec("INSERT INTO file_versions (path, operation, kind, frontmatter, body, actor, at) VALUES (?, 'deleted', ?, ?, ?, ?, ?)", path, current.kind, current.frontmatter, current.body, actor, now);
}

/** Every kept version of a note, newest first. */
export function versionsOf(sql: SqlStorage, path: string): NoteVersion[] {
  return sql.exec<NoteVersion & Record<string, SqlStorageValue>>("SELECT id, path, operation, actor, at FROM file_versions WHERE path = ? ORDER BY id DESC", path).toArray();
}

/** Puts a note back to how one of its versions left it, as a new version. Returns the note's path, or null when there's no such version. */
export function restoreVersion(sql: SqlStorage, id: number, now: string): string | null {
  const version = sql.exec<FileRow>("SELECT path, kind, frontmatter, body FROM file_versions WHERE id = ? AND operation != 'deleted'", id).toArray()[0];
  if (!version) return null;
  writeFile(sql, version.path, version.kind as NoteKind, JSON.parse(version.frontmatter), version.body, now, `restore:${id}`);
  rebuildLinks(sql);
  return version.path;
}
