import type { ToolCall } from "./types";
import { londonDate, nextLondonMidnight } from "./vault";

/** The open batch is filed this long after the last thing said, so a run of messages is filed once. */
export const QUIET_SECONDS = 60;
/** A batch closes when nothing has been said for this long. */
export const BATCH_IDLE_MINUTES = 30;
/** A batch also closes after this many things said, so each filing stays small. */
export const BATCH_ENTRY_CAP = 40;
/** And once it holds about 24,000 tokens of text, at four characters a token. */
export const BATCH_CHAR_CAP = 96_000;

export type CloseReason = "idle" | "entry_cap" | "size_cap" | "midnight" | "migrated";

/** One thing said, by the person or by the assistant in a voice call. Entries are never edited. */
export interface LogEntry {
  id: number;
  batch_id: string;
  at: string;
  /** Where it was said: `voice:<session id>` for a voice call, `app:<name>` for a connected app. */
  source: string;
  role: "user" | "assistant";
  text: string;
  tool_calls: ToolCall[];
}

export type NewEntry = Pick<LogEntry, "at" | "role"> & { text?: string; tool_calls?: ToolCall[] };

/** A run of consecutive entries that's filed together. At most one is open. */
export interface BatchRow extends Record<string, SqlStorageValue> {
  id: string;
  started_at: string;
  last_entry_at: string;
  last_entry_id: number;
  user_entries: number;
  chars: number;
  /** The last entry a filing pass has put in the vault. */
  filed_through: number;
  /** The last entry a pass has read, whether or not it managed to file it, so a draft that can't succeed isn't run again on the same entries. */
  tried_through: number;
  closed_at: string | null;
  close_reason: string | null;
  file_after: string;
  attempts: number;
  settled_at: string | null;
  reflection: string | null;
  error: string | null;
}

interface EntryRow extends Record<string, SqlStorageValue> {
  id: number;
  batch_id: string;
  at: string;
  source: string;
  role: string;
  text: string;
  tool_calls: string;
}

export const voiceSource = (sessionId: string) => `voice:${sessionId}`;
/** Apps name themselves and the name ends up in front of the filing model, so only plain words get through. */
export function appSource(name?: string): string {
  const plain = (name ?? "").replace(/[^\p{L}\p{N} .-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return plain ? `app:${plain}` : "app";
}

/** How a source reads in the log the filing model sees. */
export function sourceLabel(source: string): string {
  if (source.startsWith("voice:")) return `voice call ${source.slice("voice:".length, "voice:".length + 8)}`;
  if (source.startsWith("app:")) return source.slice("app:".length);
  return "another app";
}

export function getBatch(sql: SqlStorage, id: string): BatchRow | undefined {
  return sql.exec<BatchRow>("SELECT * FROM batches WHERE id = ?", id).toArray()[0];
}

export function openBatch(sql: SqlStorage): BatchRow | undefined {
  return sql.exec<BatchRow>("SELECT * FROM batches WHERE closed_at IS NULL ORDER BY started_at DESC LIMIT 1").toArray()[0];
}

/** Closes a batch and has it settled straight away, unless a failed pass is already waiting to be retried. */
export function closeBatch(sql: SqlStorage, batch: BatchRow, reason: CloseReason, at: string): void {
  const fileAfter = batch.attempts > 0 && batch.file_after > at ? batch.file_after : at;
  sql.exec("UPDATE batches SET closed_at = ?, close_reason = ?, file_after = ? WHERE id = ? AND closed_at IS NULL", at, reason, fileAfter, batch.id);
}

/** Closes the open batch when it's gone quiet or its London day has ended. */
export function closeExpiredBatch(sql: SqlStorage, now: Date): void {
  const batch = openBatch(sql);
  if (!batch) return;
  const at = now.toISOString();
  if (londonDate(batch.started_at) !== londonDate(at)) closeBatch(sql, batch, "midnight", at);
  else if (now.getTime() - Date.parse(batch.last_entry_at) >= BATCH_IDLE_MINUTES * 60_000) closeBatch(sql, batch, "idle", at);
}

/** Adds entries to the open batch, starting one when there isn't any, and closes it when it's full. */
export function appendEntries(sql: SqlStorage, source: string, entries: NewEntry[], now: Date): void {
  if (!entries.length) return;
  closeExpiredBatch(sql, now);
  const at = now.toISOString();
  let batch = openBatch(sql);
  if (!batch) {
    const id = crypto.randomUUID();
    sql.exec("INSERT INTO batches (id, started_at, last_entry_at, file_after) VALUES (?, ?, ?, ?)", id, at, at, at);
    batch = getBatch(sql, id)!;
  }
  let lastId = batch.last_entry_id;
  for (const entry of entries) {
    lastId = sql
      .exec<{ id: number }>("INSERT INTO entries (batch_id, at, source, role, text, tool_calls) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", batch.id, entry.at, source, entry.role, entry.text ?? "", JSON.stringify(entry.tool_calls ?? []))
      .one().id;
  }
  const quiet = new Date(now.getTime() + QUIET_SECONDS * 1000).toISOString();
  const userEntries = batch.user_entries + entries.filter((e) => e.role === "user").length;
  const chars = batch.chars + entries.reduce((sum, e) => sum + (e.text?.length ?? 0), 0);
  sql.exec(
    "UPDATE batches SET last_entry_at = ?, last_entry_id = ?, user_entries = ?, chars = ?, file_after = ? WHERE id = ?",
    at,
    lastId,
    userEntries,
    chars,
    batch.attempts > 0 && batch.file_after > quiet ? batch.file_after : quiet,
    batch.id,
  );
  if (userEntries >= BATCH_ENTRY_CAP) closeBatch(sql, getBatch(sql, batch.id)!, "entry_cap", at);
  else if (chars >= BATCH_CHAR_CAP) closeBatch(sql, getBatch(sql, batch.id)!, "size_cap", at);
}

/** Has the open batch filed now when it holds something from this source that no pass has read. */
export function fileSourceNow(sql: SqlStorage, source: string, at: string): void {
  sql.exec(
    `UPDATE batches SET file_after = ? WHERE closed_at IS NULL AND attempts = 0 AND file_after > ?
     AND EXISTS (SELECT 1 FROM entries e WHERE e.batch_id = batches.id AND e.source = ? AND e.id > batches.filed_through)`,
    at,
    at,
    source,
  );
}

const WAITING = "settled_at IS NULL AND error IS NULL AND (closed_at IS NOT NULL OR tried_through < last_entry_id)";

/** The batches with a filing pass to run, oldest first: closed ones to settle, and the open one when it has entries no pass has read. */
export function waitingBatches(sql: SqlStorage): BatchRow[] {
  return sql.exec<BatchRow>(`SELECT * FROM batches WHERE ${WAITING} ORDER BY started_at, rowid`).toArray();
}

/** Every moment the alarm has something to do for the log: a filing pass coming due, or the open batch going idle or reaching midnight. */
export function logDeadlines(sql: SqlStorage, canFile: boolean): number[] {
  const deadlines = canFile ? waitingBatches(sql).map((batch) => Date.parse(batch.file_after)) : [];
  const open = openBatch(sql);
  if (open) deadlines.push(Date.parse(open.last_entry_at) + BATCH_IDLE_MINUTES * 60_000, Date.parse(nextLondonMidnight(open.started_at)));
  return deadlines;
}

export function batchEntries(sql: SqlStorage, batchId: string, through: number): LogEntry[] {
  return sql.exec<EntryRow>("SELECT * FROM entries WHERE batch_id = ? AND id <= ? ORDER BY id", batchId, through).toArray().map(toEntry);
}

/** What the person has said that no filing pass has read yet, oldest first. `except` leaves one source out. */
export function unfiledEntries(sql: SqlStorage, except = ""): LogEntry[] {
  return sql
    .exec<EntryRow>(
      `SELECT e.* FROM entries e JOIN batches b ON b.id = e.batch_id
       WHERE b.settled_at IS NULL AND e.id > b.filed_through AND e.role = 'user' AND e.text != '' AND e.source != ? ORDER BY e.id`,
      except,
    )
    .toArray()
    .map(toEntry);
}

/** The batch holding the newest entry from a source, and that entry's id. */
export function batchOfSource(sql: SqlStorage, source: string): { batch: BatchRow; lastEntryId: number } | undefined {
  const last = sql.exec<{ id: number; batch_id: string }>("SELECT id, batch_id FROM entries WHERE source = ? ORDER BY id DESC LIMIT 1", source).toArray()[0];
  const batch = last && getBatch(sql, last.batch_id);
  return batch ? { batch, lastEntryId: last.id } : undefined;
}

/** How many things the person has said in voice calls since a moment, for the daily cap on replies. */
export function voiceTurnsSince(sql: SqlStorage, since: string): number {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM entries WHERE role = 'user' AND source LIKE 'voice:%' AND at >= ?", since).one().n;
}

export function settledSince(sql: SqlStorage, since: string): number {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM batches WHERE settled_at > ?", since).one().n;
}

function toEntry(row: EntryRow): LogEntry {
  return { id: row.id, batch_id: row.batch_id, at: row.at, source: row.source, role: row.role as LogEntry["role"], text: row.text, tool_calls: JSON.parse(row.tool_calls) };
}
