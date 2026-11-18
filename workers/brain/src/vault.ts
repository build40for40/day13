import type { JsonValue } from "./profile";
import { USER_MD } from "./profile";
import type { DumpItem, ItemKind, Reflection } from "./reflection";
import { linkKind, parseWikilinks, wikilink } from "./wikilinks";

export type NoteKind = "user" | "memory" | "session" | ItemKind | "topic";

export const NOTE_KINDS: readonly NoteKind[] = ["user", "memory", "session", "idea", "question", "task", "thought", "topic"];

const ITEM_FOLDERS: Record<ItemKind, string> = { idea: "ideas", question: "questions", task: "tasks", thought: "thoughts" };
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

/**
 * Writes everything one reflection learned into the vault, then rebuilds the links. Running it again with the same input changes nothing:
 * every line a session adds carries that session's [[wikilink]], and a rerun replaces that session's lines.
 */
export function writeReflection(sql: SqlStorage, session: ReflectedSession, now: string): string {
  const { reflection } = session;
  const actor = `session:${session.id}`;
  const sessionPath = sessionNotePath(session);
  const sessionLink = wikilink(sessionPath);

  const claimed = new Set<string>();
  const filed = reflection.items.map((item) => ({ item, path: writeItem(sql, session, item, now, claimed) }));
  writeFile(sql, sessionPath, "session", { session_id: session.id, date: londonDate(session.started_at) }, sessionBody(session, filed), now, actor);

  for (const topic of [...new Set(reflection.items.flatMap((item) => item.topics))]) {
    const path = topicPath(topic);
    const lines = filed.filter(({ item }) => item.topics.includes(topic)).map(({ item, path: itemPath }) => `- ${wikilink(itemPath, item.title)} (${sessionLink})`);
    const current = readFile(sql, path);
    writeFile(sql, path, "topic", current?.frontmatter ?? { topic }, editSection(current?.body ?? `# ${topic}\n`, FILED, replaceSessionLines(sessionLink, lines)), now, actor);
  }

  const user = readFile(sql, USER_MD);
  if (user) {
    writeFile(sql, USER_MD, "user", user.frontmatter, editSection(user.body, LEARNED, sessionEntries(sessionLink, reflection.facts)), now, actor);
  }

  const memory = readFile(sql, MEMORY_MD);
  if (memory || reflection.lessons.length) {
    const body = editSection(memory?.body ?? MEMORY_START, LESSONS, sessionEntries(sessionLink, reflection.lessons));
    writeFile(sql, MEMORY_MD, "memory", memory?.frontmatter ?? {}, body, now, actor);
  }

  rebuildLinks(sql);
  return sessionPath;
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

/**
 * Writes one dumped item as its own note and returns its path. The path comes from the London day and the title, with a
 * number added when another session already has that path, so a rerun of the same session lands on the same note.
 */
function writeItem(sql: SqlStorage, session: ReflectedSession, item: DumpItem, now: string, claimed: Set<string>): string {
  const base = `${ITEM_FOLDERS[item.kind]}/${londonDate(session.started_at)}-${slugify(item.title)}`;
  const takenByAnother = (path: string) => {
    const current = readFile(sql, path);
    return current !== null && current.frontmatter.session_id !== session.id;
  };
  let path = `${base}.md`;
  for (let n = 2; claimed.has(path) || takenByAnother(path); n++) path = `${base}-${n}.md`;
  claimed.add(path);
  const topics = item.topics.map((topic) => wikilink(topicPath(topic), topic));
  const body = [
    `# ${item.title}`,
    item.detail,
    item.answer ? `## Answer\n\n${item.answer}` : "",
    [topics.length ? `Filed under ${topics.join(", ")}.` : "", `From ${wikilink(sessionNotePath(session))}.`].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
  writeFile(sql, path, item.kind, { kind: item.kind, session_id: session.id, date: londonDate(session.started_at), topics: item.topics }, body, now, `session:${session.id}`);
  return path;
}

function sessionBody({ started_at, reflection }: ReflectedSession, filed: { item: DumpItem; path: string }[]): string {
  const list = (heading: string, items: string[]) => (items.length ? `## ${heading}\n\n${items.map((i) => `- ${i}`).join("\n")}` : "");
  return [
    `# Conversation, ${londonDay(started_at)}`,
    reflection.summary,
    list(FILED, filed.map(({ item, path }) => `${wikilink(path, item.title)} (${item.kind})`)),
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
