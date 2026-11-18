import { DurableObject } from "cloudflare:workers";
import type Anthropic from "@anthropic-ai/sdk";
import { createClient, liveModel } from "./claude";
import { consolidate, needsConsolidation } from "./consolidation";
import { error } from "./http";
import { USER_MD, type JsonValue, type Preferences, type Profile, type ProfilePatch, type PublicProfile } from "./profile";
import { assembleContext, MAX_RECENT_ITEMS, MAX_SESSION_NOTES, MAX_TOPICS, OPENING_LINE, type ContextSources, type Note } from "./prompt";
import { renderRecall, search, type SearchableNote } from "./recall";
import { REFERENCE } from "./reference";
import { isRetryable, reflect, type Reflection } from "./reflection";
import { migrate } from "./schema";
import { starterAbout, starterPreferences } from "./seed";
import { appendUserText, runTurn } from "./turn";
import type { StreamEvent, Turn } from "./types";
import { londonDate, londonDay, londonTime, MEMORY_MD, nextLondonMidnight, noteTitle, readFile, readLearned, replaceAbout, restoreVersion, splitLearned, versionsOf, writeConsolidation, writeFile, writeReflection, type NoteKind, type NoteVersion } from "./vault";

/** A session ends when the person has been quiet this long, in case the client never says it's done. */
export const IDLE_MINUTES = 30;
/** A session also ends after this many user turns, because what it learns only reaches the context of the next one. */
export const TURN_CAP = 40;
/** One person gets this many replies from Claude in any 24 hours, so a runaway client can't run up a bill. */
export const DAILY_TURN_CAP = 200;
/** How long to wait before trying a failed reflection again, by attempt. After the last one it's saved as failed. */
export const REFLECTION_RETRY_MINUTES = [1, 5, 30, 120];
const REFLECTION_TIMEOUT_MS = 10 * 60_000;
const ITEM_KINDS_SQL = "('idea', 'question', 'task', 'event', 'thought')";
const CAPTURE_SESSION = "capture_session";

const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" };
export const TURN_FAILED = "Sorry, I lost the thread there. Could you say that again?";

/** What `open_brain` starts from: a voice session's sources, plus captures still waiting to be filed. */
export type Brief = ContextSources & { unfiled: Capture[] };
interface Capture {
  at: string;
  text: string;
}
export type EndReason = "ended" | "replaced" | "idle" | "turn_cap" | "midnight";
export type ReflectionStatus = "not_ended" | "pending" | "done" | "failed";

/** The reflection as saved on the session, with the path of the session note it wrote. */
export type SavedReflection = Reflection & { note: string };

interface SessionRow extends Record<string, SqlStorageValue> {
  id: string;
  model: string;
  context: string;
  messages: string;
  turns: string;
  facts: string;
  user_turns: number;
  started_at: string;
  last_message_at: string;
  ended_at: string | null;
  end_reason: string | null;
  reflect_after: string | null;
  reflection_attempts: number;
  reflected_at: string | null;
  reflection: string | null;
  reflection_error: string | null;
}

interface FileRow extends Record<string, SqlStorageValue> {
  path: string;
  kind: string;
  frontmatter: string;
  body: string;
  updated_at: string;
}

export interface NewSession {
  id: string;
  started_at: string;
  opening_line: string;
}

export interface SessionView {
  id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: EndReason | null;
  user_turns: number;
  turns: Turn[];
  facts: string[];
  reflection: SavedReflection | null;
  reflection_status: ReflectionStatus;
}

export interface NoteSummary {
  path: string;
  kind: NoteKind;
  title: string;
  updated_at: string;
  /** The filing fields of a task or event: area, people, due, start, location, importance, status, inferred and topics. Only those that are set. */
  fields: Record<string, unknown>;
}

/** What a person can change on a task or event. `null` clears a field. */
export interface NotePatch {
  status?: "open" | "done" | "dropped";
  due?: string | null;
  importance?: "low" | "normal" | "high" | null;
  area?: "work" | "personal";
}

export interface NoteView extends NoteSummary {
  frontmatter: Record<string, unknown>;
  body: string;
  /** The notes that link here, like the topic notes an item is filed under. */
  linked_from: string[];
}

/**
 * Everything the assistant knows about one person.
 *
 * A client opens a session, streams turns through it and ends it. The alarm does the rest, one run at a time: it ends sessions
 * the client forgot about, files what ended sessions held into the vault, tidies what's been learned, then sets itself for the next deadline.
 */
export class UserBrain extends DurableObject<Env> {
  private ready = false;
  /** In memory, which is fine for one instance: if it's evicted mid-turn, the turn's stream breaks and nothing was saved. */
  private readonly busySessions = new Set<string>();

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private init(): void {
    if (this.ready) return;
    this.ctx.storage.transactionSync(() => {
      const now = new Date().toISOString();
      if (migrate(this.sql, now) === 0) writeFile(this.sql, USER_MD, "user", starterPreferences, starterAbout, now, "seed");
    });
    this.ready = true;
  }

  // Profile

  /** USER.md as the person would see it. */
  getProfile(): PublicProfile {
    const { about, ...rest } = this.readUserMd();
    return { ...rest, ...splitLearned(about) };
  }

  /** Replaces the person's own text and preferences. What the assistant learned stays as it is. */
  updateProfile(patch: ProfilePatch): PublicProfile {
    const current = this.readUserMd();
    const body = patch.about === undefined ? current.about : replaceAbout(current.about, patch.about);
    writeFile(this.sql, USER_MD, "user", patch.preferences ?? current.preferences, body, new Date().toISOString(), "user");
    return this.getProfile();
  }

  /** Deletes everything this object holds: the vault and its versions, every session and the alarm. */
  async wipe(): Promise<void> {
    // From compatibility date 2026-02-24 deleteAll() clears the alarm too, so nothing wakes the empty object and seeds it again.
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }

  // Sessions

  /** Starts a session, ending any the person still had open: there's one conversation at a time. */
  async createSession(): Promise<NewSession> {
    this.init();
    const now = new Date();
    const at = now.toISOString();
    for (const open of this.openSessions()) if (!this.busySessions.has(open.id)) this.endSession(open.id, "replaced", now);
    const session: NewSession = { id: crypto.randomUUID(), started_at: at, opening_line: OPENING_LINE };
    const turns: Turn[] = [{ role: "assistant", at, text: OPENING_LINE }];
    // The model and context are fixed for the session, so a config change mid-conversation can't break the prompt cache.
    this.sql.exec(
      "INSERT INTO sessions (id, model, context, turns, started_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)",
      session.id,
      liveModel(this.env),
      this.assembleContext(at),
      JSON.stringify(turns),
      at,
      at,
    );
    await this.setNextAlarm();
    return session;
  }

  /** Streams the reply to one turn as server-sent events, saving the session only once the reply is complete. */
  takeTurn(sessionId: string, text: string): Response {
    this.init();
    const now = new Date();
    this.endExpiredSessions(now);
    const row = this.getSessionRow(sessionId);
    if (!row) return error(404, "session_not_found");
    if (row.ended_at) return error(409, "session_ended");
    if (this.busySessions.has(sessionId)) return error(409, "turn_in_progress");
    if (!this.env.ANTHROPIC_API_KEY) return error(503, "live_sessions_unavailable");
    if (this.turnsSince(new Date(now.getTime() - 24 * 3600 * 1000)) >= DAILY_TURN_CAP) return error(429, "daily_cap");

    this.busySessions.add(sessionId);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const emit = (event: StreamEvent) => void writer.write(encoder.encode(sse(event))).catch(() => {});

    const work = (async () => {
      try {
        const outcome = await runTurn({
          client: createClient(this.env.ANTHROPIC_API_KEY),
          model: row.model,
          context: row.context,
          messages: appendUserText(JSON.parse(row.messages), text),
          recall: (query) => this.recall(query),
          emit,
        });
        const at = now.toISOString();
        const userTurns = row.user_turns + 1;
        this.sql.exec(
          "UPDATE sessions SET messages = ?, turns = ?, facts = ?, user_turns = ?, last_message_at = ? WHERE id = ?",
          JSON.stringify(outcome.messages),
          JSON.stringify([...JSON.parse(row.turns), { role: "user", at, text } satisfies Turn, ...outcome.turns]),
          JSON.stringify([...JSON.parse(row.facts), ...outcome.facts]),
          userTurns,
          at,
          sessionId,
        );
        const ended = userTurns >= TURN_CAP;
        if (ended) this.endSession(sessionId, "turn_cap", new Date());
        await this.setNextAlarm();
        emit({ type: "done", session_ended: ended });
        console.log(JSON.stringify({ event: "brain_turn", session_id: sessionId, model: row.model, user_turns: userTurns, ...outcome.timings, usage: outcome.usage }));
      } catch (e) {
        // Nothing was saved, so the client can send the same words again. The error can't hold the prompt: the SDK only reports the API's own message.
        console.error(JSON.stringify({ event: "brain_turn_failed", session_id: sessionId, model: row.model, error: String(e) }));
        emit({ type: "error", message: TURN_FAILED });
      } finally {
        this.busySessions.delete(sessionId);
        await writer.close().catch(() => {});
      }
    })();
    this.ctx.waitUntil(work);
    return new Response(readable, { headers: SSE_HEADERS });
  }

  /** Closes a session for good and has the alarm file it straight away. One where nothing was said is dropped instead. */
  async finishSession(sessionId: string): Promise<SessionView | "dropped" | "session_not_found" | "session_ended" | "turn_in_progress"> {
    this.init();
    const row = this.getSessionRow(sessionId);
    if (!row) return "session_not_found";
    if (row.ended_at) return "session_ended";
    if (this.busySessions.has(sessionId)) return "turn_in_progress";
    this.endSession(sessionId, "ended", new Date());
    await this.setNextAlarm();
    return this.getSession(sessionId) ?? "dropped";
  }

  /**
   * Keeps something said in another app, like a chat with an MCP client. Captures gather in one open session with no replies,
   * which ends and is filed like any conversation once it's been quiet for IDLE_MINUTES, reaches TURN_CAP or passes midnight.
   */
  async capture(text: string): Promise<void> {
    this.init();
    const now = new Date();
    const at = now.toISOString();
    this.endExpiredSessions(now);
    const turn: Turn = { role: "user", at, text };
    const open = this.openCaptureSession();
    if (open) {
      const userTurns = open.user_turns + 1;
      this.sql.exec("UPDATE sessions SET turns = ?, user_turns = ?, last_message_at = ? WHERE id = ?", JSON.stringify([...JSON.parse(open.turns), turn]), userTurns, at, open.id);
      if (userTurns >= TURN_CAP) this.endSession(open.id, "turn_cap", now);
    } else {
      const id = crypto.randomUUID();
      this.sql.exec("INSERT INTO sessions (id, model, context, turns, user_turns, started_at, last_message_at) VALUES (?, 'capture', '', ?, 1, ?, ?)", id, JSON.stringify([turn]), at, at);
      this.saveSetting(CAPTURE_SESSION, id);
    }
    await this.setNextAlarm();
  }

  getSession(sessionId: string): SessionView | null {
    this.init();
    const row = this.getSessionRow(sessionId);
    return row ? sessionView(row) : null;
  }

  // The vault

  /** Every note, newest first, or only the notes of one kind. */
  listNotes(kind?: NoteKind): NoteSummary[] {
    this.init();
    const rows = kind
      ? this.sql.exec<FileRow>("SELECT * FROM files WHERE kind = ? ORDER BY updated_at DESC, path", kind).toArray()
      : this.sql.exec<FileRow>("SELECT * FROM files ORDER BY updated_at DESC, path").toArray();
    return rows.map(noteSummary);
  }

  getNote(path: string): NoteView | null {
    this.init();
    const row = this.sql.exec<FileRow>("SELECT * FROM files WHERE path = ?", path).toArray()[0];
    if (!row) return null;
    const linkedFrom = this.sql.exec<{ src: string }>("SELECT DISTINCT src FROM links WHERE dst = ? ORDER BY src", path).toArray();
    return { ...noteSummary(row), frontmatter: JSON.parse(row.frontmatter), body: row.body, linked_from: linkedFrom.map((l) => l.src) };
  }

  /** Changes a task or event's status, due date, importance or area, keeping the version. Done tasks get a `completed_at`. */
  updateNote(path: string, patch: NotePatch): NoteView | "note_not_found" | "not_a_task" {
    this.init();
    const row = this.sql.exec<FileRow>("SELECT * FROM files WHERE path = ?", path).toArray()[0];
    if (!row) return "note_not_found";
    if (row.kind !== "task" && row.kind !== "event") return "not_a_task";
    const now = new Date().toISOString();
    const frontmatter: Record<string, JsonValue> = JSON.parse(row.frontmatter);
    for (const key of ["due", "importance"] as const) {
      if (key in patch) patch[key] === null || patch[key] === undefined ? delete frontmatter[key] : (frontmatter[key] = patch[key]);
    }
    if (patch.area) frontmatter.area = patch.area;
    if (patch.status) {
      frontmatter.status = patch.status;
      if (patch.status === "done") frontmatter.completed_at = now;
      else delete frontmatter.completed_at;
    }
    this.ctx.storage.transactionSync(() => writeFile(this.sql, path, row.kind as NoteKind, frontmatter, row.body, now, "user"));
    return this.getNote(path)!;
  }

  /** Every kept version of a note, newest first: who wrote it and when. */
  listVersions(path: string): NoteVersion[] {
    this.init();
    return versionsOf(this.sql, path);
  }

  /** Puts a note back to how one of its versions left it. Returns the note's path, or null when there's no such version. */
  restoreVersion(id: number): string | null {
    this.init();
    return this.ctx.storage.transactionSync(() => restoreVersion(this.sql, id, new Date().toISOString()));
  }

  /** What a voice session starts from, for clients that open the brain another way. */
  getBrief(): Brief {
    this.init();
    return { ...this.contextSources(new Date().toISOString()), unfiled: this.unfiledCaptures() };
  }

  /** What the `recall` tool answers with: the best matches from this person's notes and the shared reference notes. */
  recall(query: string): string {
    this.init();
    const vault = this.sql.exec<SearchableNote & Record<string, SqlStorageValue>>("SELECT path, body FROM files ORDER BY path").toArray();
    const unfiled = this.unfiledCaptures().map(({ at, text }) => ({ path: `Not filed yet, captured at ${londonTime(at)} on ${londonDay(at)}`, body: text }));
    return renderRecall(search([...unfiled, ...vault, ...REFERENCE], query));
  }

  // The alarm

  async alarm(): Promise<void> {
    this.init();
    this.endExpiredSessions(new Date());
    await this.reflectOnEndedSessions();
    await this.consolidateIfDue();
    await this.setNextAlarm();
  }

  /** The Durable Object has one alarm, so it's set for whichever comes first: an open session going idle, London midnight or a reflection. */
  private async setNextAlarm(): Promise<void> {
    const now = Date.now();
    const deadlines: number[] = [];
    for (const open of this.openSessions()) deadlines.push(Date.parse(open.last_message_at) + IDLE_MINUTES * 60_000, Date.parse(nextLondonMidnight(open.started_at)));
    if (this.env.ANTHROPIC_API_KEY) deadlines.push(...this.pendingReflections().map((row) => Date.parse(row.reflect_after ?? row.ended_at!)));
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(Math.min(...deadlines), now + 1_000));
  }

  // Sessions, privately

  private getSessionRow(id: string): SessionRow | undefined {
    return this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE id = ?", id).toArray()[0];
  }

  private openCaptureSession(): SessionRow | undefined {
    const id = this.setting(CAPTURE_SESSION);
    const row = id ? this.getSessionRow(id) : undefined;
    return row && !row.ended_at ? row : undefined;
  }

  private unfiledCaptures(): Capture[] {
    const rows = this.sql.exec<{ turns: string }>("SELECT turns FROM sessions WHERE model = 'capture' AND reflected_at IS NULL ORDER BY started_at").toArray();
    return rows.flatMap((row) => JSON.parse(row.turns) as Turn[]).flatMap(({ at, text }) => (text ? [{ at, text }] : []));
  }

  private openSessions(): SessionRow[] {
    return this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at").toArray();
  }

  private endExpiredSessions(now: Date): void {
    for (const row of this.openSessions()) {
      if (this.busySessions.has(row.id)) continue;
      if (londonDate(row.started_at) !== londonDate(now.toISOString())) this.endSession(row.id, "midnight", now);
      else if (now.getTime() - Date.parse(row.last_message_at) >= IDLE_MINUTES * 60_000) this.endSession(row.id, "idle", now);
    }
  }

  /** Closes a session and queues its reflection. A session nothing was said in is just dropped. */
  private endSession(id: string, reason: EndReason, now: Date): void {
    const at = now.toISOString();
    this.sql.exec("DELETE FROM sessions WHERE id = ? AND user_turns = 0", id);
    this.sql.exec("UPDATE sessions SET ended_at = ?, end_reason = ?, reflect_after = ? WHERE id = ? AND ended_at IS NULL", at, reason, at, id);
  }

  private turnsSince(since: Date): number {
    return this.sql.exec<{ turns: number }>("SELECT COALESCE(SUM(user_turns), 0) AS turns FROM sessions WHERE last_message_at >= ?", since.toISOString()).one().turns;
  }

  private assembleContext(at: string): string {
    return assembleContext(this.contextSources(at));
  }

  private contextSources(at: string): ContextSources {
    const { preferences, about } = this.readUserMd();
    const sessionNotes = this.sql.exec<FileRow>("SELECT path, frontmatter, body FROM files WHERE kind = 'session' ORDER BY path DESC LIMIT ?", MAX_SESSION_NOTES).toArray();
    const topics = this.sql
      .exec<{ path: string; items: number }>(
        `SELECT f.path, (SELECT COUNT(*) FROM links l WHERE l.src = f.path AND l.kind IN ${ITEM_KINDS_SQL}) AS items
         FROM files f WHERE f.kind = 'topic' ORDER BY items DESC, f.path LIMIT ?`,
        MAX_TOPICS,
      )
      .toArray();
    const recent = this.sql.exec<FileRow>(`SELECT path, body FROM files WHERE kind IN ${ITEM_KINDS_SQL} ORDER BY updated_at DESC, path DESC LIMIT ?`, MAX_RECENT_ITEMS).toArray();
    return {
      user: { preferences, about },
      memory: readFile(this.sql, MEMORY_MD)?.body ?? null,
      sessionNotes: sessionNotes as Note[],
      topics,
      recent: recent.map((row) => ({ path: row.path, title: noteTitle(row.path, row.body) })),
      reference: REFERENCE.map((note) => note.path),
      time: londonTime(at),
      today: londonDay(at),
    };
  }

  // Reflection

  private pendingReflections(): SessionRow[] {
    return this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE ended_at IS NOT NULL AND reflected_at IS NULL AND reflection_error IS NULL ORDER BY ended_at, rowid").toArray();
  }

  /** Reflects on every ended session that's due. A failure worth retrying is pushed back; one that isn't is saved as failed. */
  private async reflectOnEndedSessions(): Promise<void> {
    const due = this.pendingReflections().filter((row) => Date.parse(row.reflect_after ?? row.ended_at!) <= Date.now());
    if (!due.length) return;
    if (!this.env.ANTHROPIC_API_KEY) {
      console.warn(JSON.stringify({ event: "brain_reflection_skipped", reason: "no_api_key", pending: due.length }));
      return;
    }
    const client = createClient(this.env.ANTHROPIC_API_KEY, REFLECTION_TIMEOUT_MS);
    for (const row of due) {
      try {
        await this.reflectOn(client, row);
      } catch (e) {
        const wait = REFLECTION_RETRY_MINUTES[row.reflection_attempts];
        const retryable = isRetryable(e) && wait !== undefined;
        console.error(JSON.stringify({ event: "brain_reflection_failed", session_id: row.id, retryable, attempt: row.reflection_attempts + 1, error: String(e) }));
        if (retryable) {
          this.sql.exec("UPDATE sessions SET reflection_attempts = reflection_attempts + 1, reflect_after = ? WHERE id = ?", new Date(Date.now() + wait * 60_000).toISOString(), row.id);
        } else {
          this.sql.exec("UPDATE sessions SET reflection_error = ? WHERE id = ?", e instanceof Error ? e.message : String(e), row.id);
        }
      }
    }
  }

  private async reflectOn(client: Anthropic, row: SessionRow): Promise<void> {
    const started = Date.now();
    const { preferences, about } = this.readUserMd();
    const topics = this.sql.exec<{ topic: string }>("SELECT json_extract(frontmatter, '$.topic') AS topic FROM files WHERE kind = 'topic' ORDER BY path").toArray();
    const { reflection, usage } = await reflect(client, {
      user: { preferences, about },
      memory: readFile(this.sql, MEMORY_MD)?.body ?? null,
      topics: topics.map((t) => t.topic).filter(Boolean),
      turns: JSON.parse(row.turns),
      facts: JSON.parse(row.facts),
      today: `${londonDate(row.started_at)}, ${londonDay(row.started_at)}`,
    });
    const note = this.ctx.storage.transactionSync(() => {
      const current = this.getSessionRow(row.id);
      if (!current || current.reflected_at) return null;
      const now = new Date().toISOString();
      const path = writeReflection(this.sql, { id: row.id, started_at: row.started_at, reflection }, now);
      const saved: SavedReflection = { ...reflection, note: path };
      this.sql.exec("UPDATE sessions SET reflected_at = ?, reflection = ? WHERE id = ?", now, JSON.stringify(saved), row.id);
      return path;
    });
    console.log(JSON.stringify({ event: "brain_reflection", session_id: row.id, note, items: reflection.items.length, total_ms: Date.now() - started, usage }));
  }

  // Consolidation

  /**
   * Tidies what has been learned once enough conversations have been filed since the last time. It's tried once per batch:
   * a failure is logged and the next attempt waits for another conversation, so a refusal can't be retried on every alarm.
   */
  private async consolidateIfDue(): Promise<void> {
    if (!this.env.ANTHROPIC_API_KEY) return;
    const since = this.setting("consolidated_at") ?? "";
    const sessionsSince = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE reflected_at > ?", since).one().n;
    const before = readLearned(this.sql);
    if (!needsConsolidation(before, sessionsSince)) return;
    const started = Date.now();
    this.saveSetting("consolidated_at", new Date().toISOString());
    try {
      const { learned, usage } = await consolidate(createClient(this.env.ANTHROPIC_API_KEY, REFLECTION_TIMEOUT_MS), before);
      this.ctx.storage.transactionSync(() => writeConsolidation(this.sql, learned, new Date().toISOString()));
      console.log(JSON.stringify({ event: "brain_consolidation", facts: [before.facts.length, learned.facts.length], lessons: [before.lessons.length, learned.lessons.length], total_ms: Date.now() - started, usage }));
    } catch (e) {
      console.error(JSON.stringify({ event: "brain_consolidation_failed", error: String(e) }));
    }
  }

  // Storage helpers

  private setting(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private saveSetting(key: string, value: string): void {
    this.sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  private readUserMd(): Profile {
    this.init();
    const row = this.sql.exec<FileRow>("SELECT * FROM files WHERE path = ?", USER_MD).toArray()[0];
    if (!row) return { preferences: {}, about: "", updated_at: new Date(0).toISOString() };
    return { preferences: JSON.parse(row.frontmatter) as Preferences, about: row.body, updated_at: row.updated_at };
  }
}

export function sse(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    end_reason: row.end_reason as EndReason | null,
    user_turns: row.user_turns,
    turns: JSON.parse(row.turns),
    facts: JSON.parse(row.facts),
    reflection: row.reflection ? JSON.parse(row.reflection) : null,
    reflection_status: !row.ended_at ? "not_ended" : row.reflected_at ? "done" : row.reflection_error ? "failed" : "pending",
  };
}

const FIELD_KEYS = ["area", "people", "due", "start", "location", "importance", "status", "completed_at", "inferred", "topics"];

function noteSummary(row: FileRow): NoteSummary {
  const frontmatter = JSON.parse(row.frontmatter) as Record<string, unknown>;
  const fields = Object.fromEntries(FIELD_KEYS.filter((k) => frontmatter[k] !== undefined).map((k) => [k, frontmatter[k]]));
  return { path: row.path, kind: row.kind as NoteKind, title: noteTitle(row.path, row.body), updated_at: row.updated_at, fields };
}
