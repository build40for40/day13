import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteSummary, UserBrain } from "./brain";
import { renderInput, tidyItems, type DumpItem } from "./reflection";
import { api, brainFor, fakeUser, mockClaude, mockWorkos, noTaskFields } from "./testing";
import { migrate } from "./schema";
import { writeReflection } from "./vault";

beforeEach(() => {
  mockWorkos();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const item = (overrides: Partial<DumpItem>): DumpItem => ({ kind: "task", title: "Fake task", detail: "A fake detail.", answer: "", topics: ["home"], ...noTaskFields, ...overrides });

describe("tidying the task fields", () => {
  it("keeps good values and drops malformed ones", () => {
    const [good, bad] = tidyItems([
      item({ due: " 2026-11-19 ", importance: "high", area: "work", people: [" the  kids ", "Maya", "Maya"], location: "the fake school", inferred: ["due", "importance"] }),
      item({ title: "Bad one", due: "tomorrow", importance: "urgent" as never, area: "sideways" as never, people: "cat" as never, inferred: ["due", "colour" as never] }),
    ]);
    expect(good).toMatchObject({ due: "2026-11-19", importance: "high", area: "work", people: ["the kids", "Maya"], location: "the fake school", inferred: ["due", "importance"] });
    expect(bad).toMatchObject({ due: "", importance: "", area: "personal", people: [], inferred: [] });
  });

  it("only lists a field as inferred when it has a value", () => {
    const [one] = tidyItems([item({ due: "", importance: "high", inferred: ["due", "importance"] })]);
    expect(one.inferred).toEqual(["importance"]);
  });

  it("keeps start only on events, and location only on tasks and events", () => {
    const [event, idea] = tidyItems([item({ kind: "event", title: "Fake concert", start: "2026-11-21T19:30", location: "the fake hall" }), item({ kind: "idea", title: "Fake idea", start: "2026-11-21", location: "the fake hall" })]);
    expect(event).toMatchObject({ start: "2026-11-21T19:30", location: "the fake hall" });
    expect(idea).toMatchObject({ start: "", location: "" });
    expect(tidyItems([item({ kind: "event", title: "Fake event", start: "next week" })])[0].start).toBe("");
  });
});

describe("what the reflection reads", () => {
  it("includes the day the conversation started, so tomorrow can be dated", () => {
    const text = renderInput({ user: { preferences: {}, about: "" }, memory: null, topics: [], turns: [], facts: [], today: "2026-11-18, Wednesday 18 November" });
    expect(text).toContain("# Conversation date\n\n2026-11-18, Wednesday 18 November");
  });
});

describe("filing tasks and events", () => {
  it("saves the fields in the note, and says them in the body so recall finds them", async () => {
    const name = `vault_tasks_${fakeUser()}`;
    await runInDurableObject(env.USER_BRAIN.get(env.USER_BRAIN.idFromName(name)), (brain: UserBrain, state) => {
      brain.getProfile();
      const items = tidyItems([
        item({ title: "Pick up the fake costume", due: "2026-11-19", importance: "high", area: "personal", people: ["the kids"], location: "school", inferred: ["importance"] }),
        item({ kind: "event", title: "Fake school concert", start: "2026-11-21T19:30", location: "the fake hall" }),
      ]);
      writeReflection(state.storage.sql, { id: "aaaaaaaa-1111-4111-8111-111111111111", started_at: "2026-11-18T09:00:00Z", reflection: { summary: "Fake.", items, facts: [], lessons: [] } }, "2026-11-18T09:05:00Z");
      const task = state.storage.sql.exec<{ path: string; frontmatter: string; body: string }>("SELECT path, frontmatter, body FROM files WHERE kind = 'task'").one();
      expect(task.path).toBe("tasks/2026-11-18-pick-up-the-fake-costume.md");
      expect(JSON.parse(task.frontmatter)).toMatchObject({ due: "2026-11-19", importance: "high", area: "personal", people: ["the kids"], location: "school", status: "open", inferred: ["importance"] });
      expect(task.body).toContain("Due 2026-11-19. Where: school. Who: the kids.");
      const event = state.storage.sql.exec<{ path: string; frontmatter: string }>("SELECT path, frontmatter FROM files WHERE kind = 'event'").one();
      expect(event.path).toBe("events/2026-11-18-fake-school-concert.md");
      expect(JSON.parse(event.frontmatter)).toMatchObject({ start: "2026-11-21T19:30", status: "open" });
    });
  });
});

describe("the notes API for tasks", () => {
  async function dumpOneTask(sub: string): Promise<string> {
    const started = await api("/sessions", { sub, method: "POST" });
    const { id } = (await started.json()) as { id: string };
    mockClaude({ content: [{ type: "text", text: "Noted." }] });
    await api(`/sessions/${id}/turns`, { sub, method: "POST", body: { text: "I need to pick up the costume tomorrow, it matters a lot" } });
    await api(`/sessions/${id}/end`, { sub, method: "POST" });
    const output = { summary: "Fake.", items: [item({ title: "Pick up the fake costume", due: "2026-11-19", importance: "high", inferred: ["importance"] })], facts: [], lessons: [] };
    mockClaude({ content: [{ type: "text", text: JSON.stringify(output) }] });
    await runDurableObjectAlarm(brainFor(sub));
    const tasks = (await (await api("/notes?kind=task", { sub })).json()) as { notes: NoteSummary[] };
    return tasks.notes[0].path;
  }

  it("lists the filing fields with each task", async () => {
    const sub = fakeUser();
    const path = await dumpOneTask(sub);
    const { notes } = (await (await api("/notes?kind=task", { sub })).json()) as { notes: NoteSummary[] };
    expect(notes).toEqual([expect.objectContaining({ path, title: "Pick up the fake costume", fields: expect.objectContaining({ due: "2026-11-19", importance: "high", status: "open", inferred: ["importance"] }) })]);
  });

  it("marks a task done and puts it back, keeping every version", async () => {
    const sub = fakeUser();
    const path = await dumpOneTask(sub);
    const done = await api(`/notes/${path}`, { sub, method: "PATCH", body: { status: "done" } });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ frontmatter: { status: "done", completed_at: expect.any(String), due: "2026-11-19" }, fields: { status: "done" } });
    const reopened = await (await api(`/notes/${path}`, { sub, method: "PATCH", body: { status: "open", due: null } })).json();
    expect((reopened as { frontmatter: Record<string, unknown> }).frontmatter).toMatchObject({ status: "open" });
    expect((reopened as { frontmatter: Record<string, unknown> }).frontmatter).not.toHaveProperty("completed_at");
    expect((reopened as { frontmatter: Record<string, unknown> }).frontmatter).not.toHaveProperty("due");
    const versions = (await (await api(`/versions?path=${encodeURIComponent(path)}`, { sub })).json()) as { versions: unknown[] };
    expect(versions.versions.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a bad change, a missing note, a note that isn't a task and a signed-out request", async () => {
    const sub = fakeUser();
    const path = await dumpOneTask(sub);
    expect((await api(`/notes/${path}`, { sub, method: "PATCH", body: { status: "finished" } })).status).toBe(400);
    expect((await api(`/notes/${path}`, { sub, method: "PATCH", body: { due: "tomorrow" } })).status).toBe(400);
    expect((await api(`/notes/${path}`, { sub, method: "PATCH", body: {} })).status).toBe(400);
    expect((await api(`/notes/${path}`, { sub, method: "PATCH", body: { title: "x" } })).status).toBe(400);
    expect((await api("/notes/tasks/nothing.md", { sub, method: "PATCH", body: { status: "done" } })).status).toBe(404);
    expect((await api("/notes/USER.md", { sub, method: "PATCH", body: { status: "done" } })).status).toBe(409);
    expect((await api(`/notes/${path}`, { sub: null, method: "PATCH", body: { status: "done" } })).status).toBe(401);
  });

  it("only changes the signed-in person's own notes", async () => {
    const owner = fakeUser();
    const path = await dumpOneTask(owner);
    expect((await api(`/notes/${path}`, { sub: fakeUser(), method: "PATCH", body: { status: "done" } })).status).toBe(404);
  });
});

describe("the migration that adds events", () => {
  it("keeps every existing note and then accepts an event", async () => {
    await runInDurableObject(env.USER_BRAIN.get(env.USER_BRAIN.idFromName(`vault_migrate_${fakeUser()}`)), (brain: UserBrain, state) => {
      brain.getProfile();
      const sql = state.storage.sql;
      // Put the database back to how version 1 left it, with a note in it.
      sql.exec("DROP TABLE files");
      sql.exec("CREATE TABLE files (path TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('user', 'memory', 'session', 'idea', 'question', 'task', 'thought', 'topic')), frontmatter TEXT NOT NULL DEFAULT '{}', body TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)");
      sql.exec("INSERT INTO files (path, kind, frontmatter, body, updated_at) VALUES ('tasks/old.md', 'task', '{\"status\":\"open\"}', '# Old fake task', '2026-11-01T00:00:00Z')");
      sql.exec("DELETE FROM schema_migrations WHERE version = 2");
      expect(() => sql.exec("INSERT INTO files (path, kind, updated_at) VALUES ('events/x.md', 'event', 'now')")).toThrow();

      expect(migrate(sql, "2026-11-18T10:00:00Z")).toBe(1);
      expect(sql.exec<{ path: string; body: string }>("SELECT path, body FROM files WHERE path = 'tasks/old.md'").one()).toEqual({ path: "tasks/old.md", body: "# Old fake task" });
      sql.exec("INSERT INTO files (path, kind, updated_at) VALUES ('events/x.md', 'event', 'now'), ('notes/x.md', 'a_kind_added_later', 'now')");
      expect(sql.exec("SELECT path FROM files WHERE path IN ('events/x.md', 'notes/x.md')").toArray()).toHaveLength(2);
    });
  });
});
