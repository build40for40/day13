import { DurableObject } from "cloudflare:workers";
import type Anthropic from "@anthropic-ai/sdk";
import { createClient, liveModel } from "./claude";
import { consolidate, needsConsolidation, type VaultState } from "./consolidation";
import { itemActionRunner } from "./item-actions";
import { error } from "./http";
import { agenda } from "./items";
import { USER_MD, type JsonValue, type Preferences, type Profile, type ProfilePatch, type PublicProfile } from "./profile";
import { assembleContext, MAX_RECENT_ITEMS, MAX_SESSION_NOTES, MAX_TOPICS, OPENING_LINE, type ContextSources, type Note } from "./prompt";
import { renderRecall, search, type SearchableNote } from "./recall";
import { REFERENCE } from "./reference";
import { appendEntries, appSource, batchEntries, batchOfSource, closeExpiredBatch, fileSourceNow, getBatch, logDeadlines, settledSince, unfiledEntries, voiceSource, voiceTurnsSince, waitingBatches, type BatchRow } from "./log";
import { draft, isRetryable, reflect, tidyItems, type Area, type Importance, type Reflection } from "./reflection";
import { migrate } from "./schema";
import { starterAbout, starterPreferences } from "./seed";
import { appendUserText, runTurn } from "./turn";
import type { StreamEvent, ToolCall, Turn } from "./types";
import { filedBy, londonDate, londonDay, londonTime, MEMORY_MD, nextLondonMidnight, fieldsLine, noteTitle, readFile, readLearned, replaceAbout, restoreVersion, splitLearned, summaryOf, versionsOf, withFieldsLine, writeAddedItem, writeConsolidation, writeTidying, writeFile, writeReflection, type NoteKind, type NoteVersion } from "./vault";

/** A voice session ends when the person has been quiet this long, in case the client never says it's done. */
export const IDLE_MINUTES = 30;
/** A voice session also ends after this many user turns, because what's filed only reaches the context of the next one. */
export const TURN_CAP = 40;
/** One person gets this many replies from Claude in any 24 hours, so a runaway client can't run up a bill. */
export const DAILY_TURN_CAP = 200;
/** How long to wait before trying a failed filing pass again, by attempt. After the last one a closed batch is saved as failed. */
export const REFLECTION_RETRY_MINUTES = [1, 5, 30, 120];
const REFLECTION_TIMEOUT_MS = 10 * 60_000;
const ITEM_KINDS_SQL = "('idea', 'question', 'task', 'event', 'note', 'thought')";
/** How many open to-dos and events a reflection is shown, so it doesn't file one twice. */
const MAX_EXISTING_ITEMS = 40;
/** How many topics and topicless items one consolidation looks at. */
const MAX_TIDIED_TOPICS = 100;
const MAX_TIDIED_ITEMS = 30;

const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" };
export const TURN_FAILED = "Sorry, I lost the thread there. Could you say that again?";

/** What `open_brain` starts from: a voice session's sources, plus what's been said and not filed yet. */
export type Brief = ContextSources & { unfiled: Capture[] };
interface Capture {
  at: string;
  text: string;
}
export type EndReason = "ended" | "replaced" | "idle" | "turn_cap" | "midnight";
export type ReflectionStatus = "not_ended" | "pending" | "done" | "failed";

/** The reflection as saved on the batch, with the path of the note it wrote. */
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
  /** Events only. */
  start?: string;
  location?: string | null;
}

export type DatedKind = "task" | "event";

/** A to-do or event added directly, already sorted by whoever added it. */
export interface NewItem {
  kind: DatedKind;
  title: string;
  detail?: string;
  due?: string;
  start?: string;
  location?: string;
  importance?: Exclude<Importance, "">;
  area?: Area;
  people?: string[];
}

/** Every to-do or event, with what's been captured but not filed yet, since that may hold more. */
export interface ItemList {
  notes: NoteSummary[];
  unfiled: string[];
  /** The London day, as YYYY-MM-DD. */
  today: string;
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
 * Everything said lands in one log, whether it came through a voice session or was captured by another app. The log is filed in
 * batches: the open batch is filed a minute after things go quiet and again whenever more is said, and once it closes it's settled
 * for good. A session is only the live state of one voice call. The alarm does the filing, one run at a time: it ends sessions the
 * client forgot about, closes a batch that's gone quiet, files what's waiting, tidies what's been learned, then sets itself for the next deadline.
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

  /** Starts a voice session, ending any the person still had open: there's one call at a time. The log carries on as it was. */
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
    if (voiceTurnsSince(this.sql, new Date(now.getTime() - 24 * 3600 * 1000).toISOString()) >= DAILY_TURN_CAP) return error(429, "daily_cap");

    this.busySessions.add(sessionId);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const emit = (event: StreamEvent) => void writer.write(encoder.encode(sse(event))).catch(() => {});

    const work = (async () => {
      const changes: ToolCall[] = [];
      const at = now.toISOString();
      const userTurn = { role: "user", at, text } satisfies Turn;
      let saved = false;
      try {
        const outcome = await runTurn({
          client: createClient(this.env.ANTHROPIC_API_KEY),
          model: row.model,
          context: row.context,
          messages: appendUserText(JSON.parse(row.messages), text),
          recall: (query) => this.recall(query, voiceSource(sessionId)),
          emit,
          itemAction: itemActionRunner({
            getNote: (path) => this.getNote(path),
            listItems: (kind) => this.listItems(kind),
            addItem: (item) => this.addItem(item, "voice"),
            updateNote: (path, patch, kind) => this.updateNote(path, patch, kind),
          }),
          onItemChange: (call) => changes.push(call),
        });
        const userTurns = row.user_turns + 1;
        const said: Turn[] = [userTurn, ...outcome.turns];
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            "UPDATE sessions SET messages = ?, turns = ?, facts = ?, user_turns = ?, last_message_at = ? WHERE id = ?",
            JSON.stringify(outcome.messages),
            JSON.stringify([...JSON.parse(row.turns), ...said]),
            JSON.stringify([...JSON.parse(row.facts), ...outcome.facts]),
            userTurns,
            at,
            sessionId,
          );
          appendEntries(this.sql, voiceSource(sessionId), said, new Date());
        });
        saved = true;
        const ended = userTurns >= TURN_CAP;
        if (ended) this.endSession(sessionId, "turn_cap", new Date());
        await this.setNextAlarm();
        emit({ type: "done", session_ended: ended });
        console.log(JSON.stringify({ event: "brain_turn", session_id: sessionId, model: row.model, user_turns: userTurns, ...outcome.timings, usage: outcome.usage }));
      } catch (e) {
        // A write can succeed before the model finishes its reply. Keep the transcript and its
        // completed writes for filing, even when the model's follow-up fails.
        if (changes.length && !saved) {
          const said: Turn[] = [userTurn, { role: "assistant", at, tool_calls: changes }];
          this.ctx.storage.transactionSync(() => {
            this.sql.exec(
              "UPDATE sessions SET messages = ?, turns = ?, user_turns = ?, last_message_at = ? WHERE id = ?",
              JSON.stringify(appendUserText(JSON.parse(row.messages), "A previous voice request changed the list, but its reply failed. Check the current list before repeating a change.")),
              JSON.stringify([...JSON.parse(row.turns), ...said]),
              row.user_turns + 1, at, sessionId,
            );
            appendEntries(this.sql, voiceSource(sessionId), said, new Date());
          });
        }
        console.error(JSON.stringify({ event: "brain_turn_failed", session_id: sessionId, model: row.model, error: String(e) }));
        emit({ type: "error", message: changes.length ? "The list changed, but I couldn’t finish the reply. Check the list before trying again." : TURN_FAILED });
      } finally {
        this.busySessions.delete(sessionId);
        await writer.close().catch(() => {});
      }
    })();
    this.ctx.waitUntil(work);
    return new Response(readable, { headers: SSE_HEADERS });
  }

  /** Closes a voice session for good and has the alarm file what was said in it straight away. One where nothing was said is dropped instead. */
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

  /** Keeps something said in another app, like a chat with an MCP client, by adding it to the log. `app` names the app when it's known. */
  async capture(text: string, app?: string): Promise<void> {
    this.init();
    const now = new Date();
    this.ctx.storage.transactionSync(() => appendEntries(this.sql, appSource(app), [{ role: "user", at: now.toISOString(), text }], now));
    await this.setNextAlarm();
  }

  getSession(sessionId: string): SessionView | null {
    this.init();
    const row = this.getSessionRow(sessionId);
    return row ? this.sessionView(row) : null;
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

  /** Files a to-do or event straight away, for when the person asked for exactly that. An area nobody gave is filed as personal and marked inferred. */
  addItem(item: NewItem, actor = "mcp"): NoteView | "invalid_item" {
    this.init();
    const [tidy] = tidyItems([
      {
        kind: item.kind,
        title: item.title,
        detail: item.detail ?? "",
        answer: "",
        topics: [],
        area: item.area ?? "personal",
        people: item.people ?? [],
        due: item.kind === "task" ? (item.due ?? "") : "",
        start: item.start ?? "",
        location: item.location ?? "",
        importance: item.importance ?? "",
        inferred: item.area ? [] : ["area"],
      },
    ]);
    if (!tidy || (tidy.kind === "event" && !tidy.start)) return "invalid_item";
    const path = this.ctx.storage.transactionSync(() => writeAddedItem(this.sql, tidy, new Date().toISOString(), actor));
    return this.getNote(path)!;
  }

  listItems(kind: DatedKind): ItemList {
    this.init();
    return { notes: this.listNotes(kind), unfiled: this.unfiledCaptures().map((capture) => capture.text), today: londonDate(new Date().toISOString()) };
  }

  /**
   * Changes a task or event's status, due date, importance or area, and an event's start or location, keeping the version.
   * Done tasks get a `completed_at`. `only` refuses a note of the other kind.
   */
  updateNote(path: string, patch: NotePatch, only?: DatedKind): NoteView | "note_not_found" | "not_a_task" {
    this.init();
    const row = this.sql.exec<FileRow>("SELECT * FROM files WHERE path = ?", path).toArray()[0];
    if (!row) return "note_not_found";
    if ((row.kind !== "task" && row.kind !== "event") || (only && row.kind !== only)) return "not_a_task";
    const now = new Date().toISOString();
    const frontmatter: Record<string, JsonValue> = JSON.parse(row.frontmatter);
    const clearable = row.kind === "event" ? (["due", "importance", "location"] as const) : (["due", "importance"] as const);
    for (const key of clearable) {
      if (key in patch) patch[key] === null || patch[key] === undefined ? delete frontmatter[key] : (frontmatter[key] = patch[key]);
    }
    if (patch.start && row.kind === "event") frontmatter.start = patch.start;
    if (patch.area) frontmatter.area = patch.area;
    if (patch.status) {
      frontmatter.status = patch.status;
      if (patch.status === "done") frontmatter.completed_at = now;
      else delete frontmatter.completed_at;
    }
    const body = withFieldsLine(row.body, fieldsLine(frontmatter, true));
    this.ctx.storage.transactionSync(() => writeFile(this.sql, path, row.kind as NoteKind, frontmatter, body, now, "user"));
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

  /**
   * What the `recall` tool answers with: the best matches from this person's notes, what they've said that isn't filed yet and the
   * shared reference notes. A voice session passes its own source as `except`, since it already has what was said in it.
   */
  recall(query: string, except?: string, area?: Area): string {
    this.init();
    const other = area === "work" ? "personal" : "work";
    const vault = this.sql
      .exec<SearchableNote & { area: string | null } & Record<string, SqlStorageValue>>("SELECT path, body, json_extract(frontmatter, '$.area') AS area FROM files ORDER BY path")
      .toArray()
      .filter((note) => !area || note.area !== other);
    const unfiled = this.unfiledCaptures(except).map(({ at, text }) => ({ path: `Not filed yet, said at ${londonTime(at)} on ${londonDay(at)}`, body: text }));
    return renderRecall(search([...unfiled, ...vault, ...REFERENCE], query));
  }

  // The alarm

  async alarm(): Promise<void> {
    this.init();
    const now = new Date();
    this.endExpiredSessions(now);
    closeExpiredBatch(this.sql, now);
    await this.fileWaitingBatches();
    await this.consolidateIfDue();
    await this.setNextAlarm();
  }

  /** The Durable Object has one alarm, so it's set for whichever comes first: an open session or batch going idle, London midnight or a filing pass. */
  private async setNextAlarm(): Promise<void> {
    const now = Date.now();
    const deadlines: number[] = [];
    for (const open of this.openSessions()) deadlines.push(Date.parse(open.last_message_at) + IDLE_MINUTES * 60_000, Date.parse(nextLondonMidnight(open.started_at)));
    deadlines.push(...logDeadlines(this.sql, Boolean(this.env.ANTHROPIC_API_KEY)));
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(Math.min(...deadlines), now + 1_000));
  }

  // Sessions, privately

  private getSessionRow(id: string): SessionRow | undefined {
    return this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE id = ?", id).toArray()[0];
  }

  private unfiledCaptures(except?: string): Capture[] {
    return unfiledEntries(this.sql, except).map(({ at, text }) => ({ at, text }));
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

  /** Closes a session and has what was said in it filed now. A session nothing was said in is just dropped. */
  private endSession(id: string, reason: EndReason, now: Date): void {
    const at = now.toISOString();
    this.sql.exec("DELETE FROM sessions WHERE id = ? AND user_turns = 0", id);
    this.sql.exec("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL", at, reason, id);
    fileSourceNow(this.sql, voiceSource(id), at);
  }

  /** A session as a client sees it. Whether it's been filed comes from the batch its last words are in. */
  private sessionView(row: SessionRow): SessionView {
    const logged = batchOfSource(this.sql, voiceSource(row.id));
    const filed = logged && (logged.batch.settled_at !== null || logged.batch.filed_through >= logged.lastEntryId);
    const reflection = logged?.batch.reflection ?? row.reflection;
    const status: ReflectionStatus = !row.ended_at ? "not_ended" : row.reflected_at || filed ? "done" : (row.reflection_error ?? logged?.batch.error) ? "failed" : "pending";
    return {
      id: row.id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      end_reason: row.end_reason as EndReason | null,
      user_turns: row.user_turns,
      turns: JSON.parse(row.turns),
      facts: JSON.parse(row.facts),
      reflection: reflection ? JSON.parse(reflection) : null,
      reflection_status: status,
    };
  }

  private assembleContext(at: string): string {
    return assembleContext(this.contextSources(at));
  }

  private contextSources(at: string): ContextSources {
    const { preferences, about } = this.readUserMd();
    const sessionNotes = this.sql.exec<FileRow>("SELECT path, frontmatter, body FROM files WHERE kind = 'session' ORDER BY path DESC LIMIT ?", MAX_SESSION_NOTES).toArray();
    const topics = this.sql
      .exec<{ path: string; items: number; area: string | null; body: string }>(
        `SELECT f.path, f.body, json_extract(f.frontmatter, '$.area') AS area, (SELECT COUNT(*) FROM links l WHERE l.src = f.path AND l.kind IN ${ITEM_KINDS_SQL}) AS items
         FROM files f WHERE f.kind = 'topic' ORDER BY items DESC, f.path LIMIT ?`,
        MAX_TOPICS,
      )
      .toArray();
    const recent = this.sql.exec<FileRow>(`SELECT path, body FROM files WHERE kind IN ${ITEM_KINDS_SQL} ORDER BY updated_at DESC, path DESC LIMIT ?`, MAX_RECENT_ITEMS).toArray();
    return {
      user: { preferences, about },
      memory: readFile(this.sql, MEMORY_MD)?.body ?? null,
      sessionNotes: sessionNotes as Note[],
      topics: topics.map(({ path, items, area, body }) => ({ path, items, ...(area ? { area } : {}), ...(summaryOf(body) ? { summary: summaryOf(body) } : {}) })),
      agenda: agenda(this.listNotes("task"), this.listNotes("event"), londonDate(at)),
      recent: recent.map((row) => ({ path: row.path, title: noteTitle(row.path, row.body) })),
      reference: REFERENCE.map((note) => note.path),
      time: londonTime(at),
      today: londonDay(at),
    };
  }

  // Filing

  /**
   * Runs the filing pass each waiting batch is due: a draft of the open batch, or the settling of a closed one. A failure worth
   * retrying is pushed back. One that isn't ends a draft there, to be picked up when more is said or the batch closes, and saves a closed batch as failed.
   */
  private async fileWaitingBatches(): Promise<void> {
    const due = waitingBatches(this.sql).filter((batch) => Date.parse(batch.file_after) <= Date.now());
    if (!due.length) return;
    if (!this.env.ANTHROPIC_API_KEY) {
      console.warn(JSON.stringify({ event: "brain_filing_skipped", reason: "no_api_key", pending: due.length }));
      return;
    }
    const client = createClient(this.env.ANTHROPIC_API_KEY, REFLECTION_TIMEOUT_MS);
    for (const batch of due) {
      const settling = batch.closed_at !== null;
      try {
        await this.fileBatch(client, batch, settling);
      } catch (e) {
        const wait = REFLECTION_RETRY_MINUTES[batch.attempts];
        const retryable = isRetryable(e) && wait !== undefined;
        console.error(JSON.stringify({ event: "brain_filing_failed", batch_id: batch.id, settling, retryable, attempt: batch.attempts + 1, error: String(e) }));
        if (retryable) {
          this.sql.exec("UPDATE batches SET attempts = attempts + 1, file_after = ? WHERE id = ?", new Date(Date.now() + wait * 60_000).toISOString(), batch.id);
        } else if (getBatch(this.sql, batch.id)?.closed_at) {
          this.sql.exec("UPDATE batches SET error = ? WHERE id = ? AND settled_at IS NULL", e instanceof Error ? e.message : String(e), batch.id);
        } else {
          this.sql.exec("UPDATE batches SET attempts = 0, tried_through = MAX(tried_through, ?) WHERE id = ?", batch.last_entry_id, batch.id);
        }
      }
    }
  }

  /** Files one batch as it stood when the pass began. Anything said while the model was working waits for the next pass. */
  private async fileBatch(client: Anthropic, batch: BatchRow, settling: boolean): Promise<void> {
    const started = Date.now();
    const { preferences, about } = this.readUserMd();
    const topics = this.sql.exec<{ topic: string; body: string }>("SELECT json_extract(frontmatter, '$.topic') AS topic, body FROM files WHERE kind = 'topic' ORDER BY path").toArray().filter((t) => t.topic);
    const people = this.sql.exec<{ name: string; body: string }>("SELECT json_extract(frontmatter, '$.name') AS name, body FROM files WHERE kind = 'person' ORDER BY path").toArray().filter((p) => p.name);
    const { reflection, usage } = await (settling ? reflect : draft)(client, {
      user: { preferences, about },
      memory: readFile(this.sql, MEMORY_MD)?.body ?? null,
      topics: topics.map((t) => t.topic),
      topicSummaries: Object.fromEntries(topics.map((t) => [t.topic, summaryOf(t.body)]).filter(([, summary]) => summary)),
      people: people.map((p) => ({ name: p.name, summary: summaryOf(p.body) })),
      entries: batchEntries(this.sql, batch.id, batch.last_entry_id),
      filed: filedBy(this.sql, batch.id),
      today: `${londonDate(batch.started_at)}, ${londonDay(batch.started_at)}`,
      existing: this.openItemTitles(batch.id),
    });
    const note = this.ctx.storage.transactionSync(() => {
      const current = getBatch(this.sql, batch.id);
      if (!current || current.settled_at) return null;
      const now = new Date().toISOString();
      const path = writeReflection(this.sql, { id: batch.id, started_at: batch.started_at, reflection }, now, { draft: !settling });
      const saved: SavedReflection = { ...reflection, note: path };
      this.sql.exec("UPDATE batches SET attempts = 0, filed_through = MAX(filed_through, ?), tried_through = MAX(tried_through, ?), reflection = ?, settled_at = ? WHERE id = ?", batch.last_entry_id, batch.last_entry_id, JSON.stringify(saved), settling ? now : null, batch.id);
      return path;
    });
    console.log(JSON.stringify({ event: "brain_filing", batch_id: batch.id, settled: settling, note, entries: batch.user_entries, items: reflection.items.length, total_ms: Date.now() - started, usage }));
  }

  /** The open to-dos and events a batch's filing mustn't repeat. Its own earlier filing is left out, since each pass files those again. */
  private openItemTitles(batchId: string): string[] {
    const rows = this.sql
      .exec<FileRow>(
        "SELECT * FROM files WHERE kind IN ('task', 'event') AND json_extract(frontmatter, '$.status') = 'open' AND COALESCE(json_extract(frontmatter, '$.session_id'), '') != ? ORDER BY updated_at DESC, path LIMIT ?",
        batchId,
        MAX_EXISTING_ITEMS,
      )
      .toArray();
    return rows.map((row) => [noteTitle(row.path, row.body), fieldsLine(JSON.parse(row.frontmatter))].filter(Boolean).join(". "));
  }

  // Consolidation

  /**
   * Tidies what has been learned once enough batches have been settled since the last time. It's tried once each time:
   * a failure is logged and the next attempt waits for another batch, so a refusal can't be retried on every alarm.
   */
  private async consolidateIfDue(): Promise<void> {
    if (!this.env.ANTHROPIC_API_KEY) return;
    const since = this.setting("consolidated_at") ?? "";
    const before = readLearned(this.sql);
    const vault = this.vaultState();
    if (!needsConsolidation(before, settledSince(this.sql, since), vault)) return;
    const started = Date.now();
    this.saveSetting("consolidated_at", new Date().toISOString());
    try {
      const { learned, tidying, usage } = await consolidate(createClient(this.env.ANTHROPIC_API_KEY, REFLECTION_TIMEOUT_MS), before, vault);
      this.ctx.storage.transactionSync(() => {
        const now = new Date().toISOString();
        writeConsolidation(this.sql, learned, now);
        writeTidying(this.sql, tidying, now);
      });
      console.log(JSON.stringify({ event: "brain_consolidation", facts: [before.facts.length, learned.facts.length], lessons: [before.lessons.length, learned.lessons.length], topics_merged: tidying.topic_merges.length, items_filed: tidying.topic_filings.length, total_ms: Date.now() - started, usage }));
    } catch (e) {
      console.error(JSON.stringify({ event: "brain_consolidation_failed", error: String(e) }));
    }
  }

  /** The topics and the items under no topic, for a consolidation to tidy. Items in a batch still being filed are left to it. */
  private vaultState(): VaultState {
    const topics = this.sql
      .exec<{ topic: string | null; body: string; items: number }>(
        `SELECT json_extract(f.frontmatter, '$.topic') AS topic, f.body, (SELECT COUNT(*) FROM links l WHERE l.src = f.path AND l.kind IN ${ITEM_KINDS_SQL}) AS items
         FROM files f WHERE f.kind = 'topic' ORDER BY f.path LIMIT ?`,
        MAX_TIDIED_TOPICS,
      )
      .toArray();
    const untopiced = this.sql
      .exec<FileRow>(
        `SELECT * FROM files WHERE kind IN ${ITEM_KINDS_SQL} AND json_array_length(COALESCE(json_extract(frontmatter, '$.topics'), '[]')) = 0
         AND json_extract(frontmatter, '$.added_by') IS NOT NULL ORDER BY updated_at DESC, path LIMIT ?`,
        MAX_TIDIED_ITEMS,
      )
      .toArray();
    return {
      topics: topics.flatMap((t) => (t.topic ? [{ name: t.topic, items: t.items, summary: summaryOf(t.body) }] : [])),
      untopiced: untopiced.map((row) => ({ path: row.path, title: noteTitle(row.path, row.body) })),
    };
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

const FIELD_KEYS = ["area", "people", "due", "start", "location", "importance", "status", "completed_at", "inferred", "topics"];

function noteSummary(row: FileRow): NoteSummary {
  const frontmatter = JSON.parse(row.frontmatter) as Record<string, unknown>;
  const fields = Object.fromEntries(FIELD_KEYS.filter((k) => frontmatter[k] !== undefined).map((k) => [k, frontmatter[k]]));
  return { path: row.path, kind: row.kind as NoteKind, title: noteTitle(row.path, row.body), updated_at: row.updated_at, fields };
}
