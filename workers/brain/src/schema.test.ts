import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UserBrain } from "./brain";
import { batchEntries, waitingBatches } from "./log";
import { migrate } from "./schema";

describe("the migration that moves filing from sessions to batches", () => {
  it("turns what sessions still had waiting into closed batches, and leaves filed and failed sessions alone", async () => {
    await runInDurableObject(env.USER_BRAIN.get(env.USER_BRAIN.idFromName("schema_batches")), (brain: UserBrain, state) => {
      brain.getProfile();
      const sql = state.storage.sql;
      sql.exec("DROP TABLE batches");
      sql.exec("DROP TABLE entries");
      sql.exec("DELETE FROM schema_migrations WHERE version >= 3");
      const insert = "INSERT INTO sessions (id, model, context, turns, user_turns, started_at, last_message_at, ended_at, reflect_after, reflection_attempts, reflected_at, reflection_error) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)";
      const user = (at: string, text: string) => ({ role: "user", at, text });
      const noted = { role: "assistant", at: "2026-11-18T09:00:02Z", text: "Noted.", tool_calls: [{ id: "toolu_1", name: "note", input: { fact: "Has a fake shed" } }] };
      sql.exec(insert, "capture-open", "capture", JSON.stringify([user("2026-11-18T10:00:00Z", "A fake capture"), user("2026-11-18T10:01:00Z", "Another fake capture")]), 2, "2026-11-18T10:00:00Z", "2026-11-18T10:01:00Z", null, null, 0, null, null);
      sql.exec(insert, "voice-pending", "claude-fake", JSON.stringify([{ role: "assistant", at: "2026-11-18T09:00:00Z", text: "Hello." }, user("2026-11-18T09:00:01Z", "A fake thought"), noted]), 1, "2026-11-18T09:00:00Z", "2026-11-18T09:00:02Z", "2026-11-18T09:05:00Z", "2026-11-18T09:10:00Z", 1, null, null);
      sql.exec(insert, "voice-filed", "claude-fake", JSON.stringify([user("2026-11-17T09:00:00Z", "Filed long ago")]), 1, "2026-11-17T09:00:00Z", "2026-11-17T09:00:00Z", "2026-11-17T09:05:00Z", null, 0, "2026-11-17T09:06:00Z", null);
      sql.exec(insert, "capture-failed", "capture", JSON.stringify([user("2026-11-16T09:00:00Z", "Never filed")]), 1, "2026-11-16T09:00:00Z", "2026-11-16T09:00:00Z", "2026-11-16T09:05:00Z", null, 4, null, "Claude declined.");

      expect(migrate(sql, "2026-11-18T11:00:00Z")).toBe(2);

      expect(waitingBatches(sql).map((b) => [b.id, b.close_reason, b.user_entries, b.attempts])).toEqual([["voice-pending", "migrated", 1, 1], ["capture-open", "migrated", 2, 0]]);
      const [voice, capture] = waitingBatches(sql);
      expect(voice.file_after).toBe("2026-11-18T09:10:00Z");
      expect(batchEntries(sql, voice.id, voice.last_entry_id).map((e) => [e.source, e.role, e.text, e.tool_calls.length])).toEqual([
        ["voice:voice-pending", "assistant", "Hello.", 0],
        ["voice:voice-pending", "user", "A fake thought", 0],
        ["voice:voice-pending", "assistant", "Noted.", 1],
      ]);
      expect(batchEntries(sql, capture.id, capture.last_entry_id).map((e) => [e.source, e.text])).toEqual([["app", "A fake capture"], ["app", "Another fake capture"]]);
      expect(sql.exec<{ id: string }>("SELECT id FROM sessions ORDER BY id").toArray().map((s) => s.id)).toEqual(["capture-failed", "voice-filed", "voice-pending"]);
    });
  });
});
