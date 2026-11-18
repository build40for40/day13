import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UserBrain } from "./brain";
import type { Reflection } from "./reflection";
import { addLines, editSection, noteTitle, slugify, topicPath, londonDate, londonDay, MAX_VERSIONS_PER_NOTE, nextLondonMidnight, readLearned, rebuildLinks, replaceAbout, replaceSessionLines, restoreVersion, sessionNotePath, splitLearned, versionsOf, writeConsolidation, writeFile, writeReflection, type ReflectedSession } from "./vault";

const reflection: Reflection = { items: [], summary: "Asked about fake things.", facts: ["Prefers short answers"], lessons: [] };

const session = (overrides: Partial<ReflectedSession> = {}): ReflectedSession => ({
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  started_at: "2026-11-10T18:00:00Z",
  reflection,
  ...overrides,
});

function inVault<T>(name: string, run: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(env.USER_BRAIN.get(env.USER_BRAIN.idFromName(name)), (brain: UserBrain, state) => {
    brain.getProfile();
    return run(state.storage.sql);
  });
}

const files = (sql: SqlStorage) => sql.exec<{ path: string; kind: string; frontmatter: string; body: string; updated_at: string }>("SELECT * FROM files ORDER BY path").toArray();
const links = (sql: SqlStorage) => sql.exec<{ src: string; dst: string; kind: string }>("SELECT * FROM links ORDER BY src, dst").toArray();
const body = (sql: SqlStorage, path: string) => sql.exec<{ body: string }>("SELECT body FROM files WHERE path = ?", path).one().body;

describe("editSection", () => {
  it("adds a missing section at the end and drops one that ends up empty", () => {
    expect(editSection("# Note\n\nText.", "Seen", () => ["- one"])).toBe("# Note\n\nText.\n\n## Seen\n\n- one\n");
    expect(editSection("# Note\n\n## Seen\n\n- one\n\n## Other\n\n- two\n", "Seen", () => [])).toBe("# Note\n\n## Other\n\n- two\n");
  });

  it("rewrites only the lines under its own heading", () => {
    const before = "# Note\n\n## Seen\n\n- one\n\n## Other\n\n- two\n";
    expect(editSection(before, "Seen", (lines) => [...lines, "- three"])).toBe("# Note\n\n## Seen\n\n- one\n- three\n\n## Other\n\n- two\n");
  });

  it("swaps one session's lines and only adds lines that are new", () => {
    expect(replaceSessionLines("[[sessions/a]]", ["- new ([[sessions/a]])"])(["- old ([[sessions/a]])", "- kept ([[sessions/b]])"])).toEqual(["- kept ([[sessions/b]])", "- new ([[sessions/a]])"]);
    expect(addLines(["- one", "- two"])(["- one"])).toEqual(["- one", "- two"]);
  });
});

describe("splitLearned and replaceAbout", () => {
  const learnedBody = "# About me\n\nFake person.\n\n## Learned in conversation\n\n- Prefers short answers ([[sessions/s1]])\n- Works nights ([[sessions/s2]])\n\n## Other\n\n- a thing\n";

  it("splits the free text from the learned entries", () => {
    expect(splitLearned(learnedBody)).toEqual({ about: "# About me\n\nFake person.\n\n## Other\n\n- a thing\n", learned: ["Prefers short answers", "Works nights"] });
  });

  it("leaves a body with no learned section alone", () => {
    expect(splitLearned("# About me")).toEqual({ about: "# About me", learned: [] });
    expect(replaceAbout("# About me", "New text")).toBe("New text");
  });

  it("keeps the learned section when about is replaced", () => {
    expect(replaceAbout(learnedBody, "# About me\n\nStill fake.")).toBe("# About me\n\nStill fake.\n\n## Learned in conversation\n\n- Prefers short answers ([[sessions/s1]])\n- Works nights ([[sessions/s2]])\n");
  });
});

describe("London time", () => {
  it("uses the London day, either side of midnight and of the clocks changing", () => {
    expect(londonDate("2026-11-10T23:59:59Z")).toBe("2026-11-10");
    expect(londonDate("2026-07-10T23:30:00Z")).toBe("2026-07-11");
    expect(londonDay("2026-11-10T18:00:00Z")).toBe("10 November 2026");
  });

  it("finds the end of the London day", () => {
    expect(nextLondonMidnight("2026-11-10T18:00:00Z")).toBe("2026-11-11T00:00:00.000Z");
    expect(nextLondonMidnight("2026-07-10T18:00:00Z")).toBe("2026-07-10T23:00:00.000Z");
    expect(nextLondonMidnight("2026-11-10T00:00:00Z")).toBe("2026-11-11T00:00:00.000Z");
  });

  it("names a session note by London day and the start of the session id", () => {
    expect(sessionNotePath(session())).toBe("sessions/2026-11-10-aaaaaaaa.md");
  });
});

describe("writeReflection", () => {
  it("writes the session note, adds what was learned to USER.md and links them", async () => {
    await inVault("vault_write", (sql) => {
      expect(writeReflection(sql, session(), "2026-11-10T19:00:00Z")).toBe("sessions/2026-11-10-aaaaaaaa.md");
      expect(files(sql).map((f) => [f.path, f.kind])).toEqual([
        ["USER.md", "user"],
        ["sessions/2026-11-10-aaaaaaaa.md", "session"],
      ]);
      expect(body(sql, "sessions/2026-11-10-aaaaaaaa.md")).toBe("# Conversation, 10 November 2026\n\nAsked about fake things.\n\n## Learned about them\n\n- Prefers short answers\n");
      expect(body(sql, "USER.md")).toContain("## Learned in conversation\n\n- Prefers short answers ([[sessions/2026-11-10-aaaaaaaa]])\n");
      expect(links(sql)).toEqual([{ src: "USER.md", dst: "sessions/2026-11-10-aaaaaaaa.md", kind: "session" }]);
    });
  });

  it("changes nothing when it runs again with the same input", async () => {
    await inVault("vault_again", (sql) => {
      writeReflection(sql, session(), "2026-11-10T19:00:00Z");
      const before = files(sql);
      writeReflection(sql, session(), "2026-11-10T20:00:00Z");
      expect(files(sql)).toEqual(before);
    });
  });

  it("replaces a session's own lines on a rerun and keeps other sessions' lines", async () => {
    await inVault("vault_rerun", (sql) => {
      writeReflection(sql, session(), "2026-11-10T19:00:00Z");
      writeReflection(sql, session({ id: "bbbbbbbb-2222-4222-8222-222222222222", reflection: { items: [], summary: "Second chat.", facts: ["Works nights", "prefers SHORT answers"], lessons: [] } }), "2026-11-10T19:30:00Z");
      writeReflection(sql, session({ reflection: { items: [], summary: "Asked about fake things.", facts: ["Likes lists"], lessons: [] } }), "2026-11-10T20:00:00Z");
      expect(splitLearned(body(sql, "USER.md")).learned).toEqual(["Works nights", "Likes lists"]);
    });
  });

  it("files lessons in MEMORY.md, once each, and in the session note", async () => {
    await inVault("vault_lessons", (sql) => {
      writeReflection(sql, session({ reflection: { ...reflection, lessons: ["Lists land better than paragraphs"] } }), "2026-11-10T19:00:00Z");
      writeReflection(sql, session({ id: "bbbbbbbb-2222-4222-8222-222222222222", reflection: { ...reflection, lessons: ["lists land BETTER than paragraphs", "Mornings are a bad time"] } }), "2026-11-10T19:30:00Z");
      expect(files(sql).find((f) => f.path === "MEMORY.md")).toMatchObject({ kind: "memory" });
      expect(body(sql, "MEMORY.md")).toBe("# Memory\n\n## Lessons\n\n- Lists land better than paragraphs ([[sessions/2026-11-10-aaaaaaaa]])\n- Mornings are a bad time ([[sessions/2026-11-10-bbbbbbbb]])\n");
      expect(body(sql, "sessions/2026-11-10-aaaaaaaa.md")).toContain("## Lessons\n\n- Lists land better than paragraphs\n");
      expect(links(sql)).toContainEqual({ src: "MEMORY.md", dst: "sessions/2026-11-10-aaaaaaaa.md", kind: "session" });
    });
  });

  it("keeps the user's own text in USER.md", async () => {
    await inVault("vault_about", (sql) => {
      const before = splitLearned(body(sql, "USER.md")).about;
      writeReflection(sql, session(), "2026-11-10T19:00:00Z");
      expect(splitLearned(body(sql, "USER.md")).about).toBe(before);
    });
  });
});

describe("filing dumped items", () => {
  const dumped: Reflection = {
    ...reflection,
    items: [
      { kind: "idea", title: "A fake shed cinema", detail: "Turn the fake shed into a tiny cinema.", answer: "", topics: ["garden", "weekend projects"] },
      { kind: "question", title: "How long does fake paint take to dry?", detail: "Asked about drying times.", answer: "About four fake hours.", topics: ["garden"] },
    ],
  };

  it("writes each item as its own note, files it under its topics and lists it in the session note", async () => {
    await inVault("vault_items", (sql) => {
      writeReflection(sql, session({ reflection: dumped }), "2026-11-10T19:00:00Z");
      expect(files(sql).map((f) => [f.path, f.kind])).toEqual([
        ["USER.md", "user"],
        ["ideas/2026-11-10-a-fake-shed-cinema.md", "idea"],
        ["questions/2026-11-10-how-long-does-fake-paint-take-to-dry.md", "question"],
        ["sessions/2026-11-10-aaaaaaaa.md", "session"],
        ["topics/garden.md", "topic"],
        ["topics/weekend-projects.md", "topic"],
      ]);
      expect(body(sql, "questions/2026-11-10-how-long-does-fake-paint-take-to-dry.md")).toBe(
        "# How long does fake paint take to dry?\n\nAsked about drying times.\n\n## Answer\n\nAbout four fake hours.\n\nFiled under [[topics/garden|garden]]. From [[sessions/2026-11-10-aaaaaaaa]].\n",
      );
      expect(body(sql, "topics/garden.md")).toBe(
        "# garden\n\n## Filed\n\n- [[ideas/2026-11-10-a-fake-shed-cinema|A fake shed cinema]] ([[sessions/2026-11-10-aaaaaaaa]])\n- [[questions/2026-11-10-how-long-does-fake-paint-take-to-dry|How long does fake paint take to dry?]] ([[sessions/2026-11-10-aaaaaaaa]])\n",
      );
      expect(body(sql, "sessions/2026-11-10-aaaaaaaa.md")).toContain("## Filed\n\n- [[ideas/2026-11-10-a-fake-shed-cinema|A fake shed cinema]] (idea)\n");
      expect(links(sql)).toContainEqual({ src: "topics/garden.md", dst: "ideas/2026-11-10-a-fake-shed-cinema.md", kind: "idea" });
    });
  });

  it("adds a later session's items to an existing topic and keeps a same-titled item from another session apart", async () => {
    await inVault("vault_items_again", (sql) => {
      writeReflection(sql, session({ reflection: dumped }), "2026-11-10T19:00:00Z");
      const later = session({ id: "bbbbbbbb-2222-4222-8222-222222222222", reflection: { ...reflection, items: [dumped.items[0]] } });
      writeReflection(sql, later, "2026-11-10T20:00:00Z");
      expect(files(sql).map((f) => f.path)).toContain("ideas/2026-11-10-a-fake-shed-cinema-2.md");
      expect(splitLines(body(sql, "topics/garden.md"))).toHaveLength(3);
    });
  });

  it("changes nothing when the same session is filed again", async () => {
    await inVault("vault_items_rerun", (sql) => {
      writeReflection(sql, session({ reflection: dumped }), "2026-11-10T19:00:00Z");
      const before = files(sql);
      writeReflection(sql, session({ reflection: dumped }), "2026-11-10T20:00:00Z");
      expect(files(sql)).toEqual(before);
    });
  });

  it("makes paths from titles and reads titles back", () => {
    expect(slugify("  Café ideas: part 2!  ")).toBe("cafe-ideas-part-2");
    expect(slugify("!!!")).toBe("untitled");
    expect(topicPath("Weekend Projects")).toBe("topics/weekend-projects.md");
    expect(noteTitle("ideas/x.md", "# A fake idea\n\nText.")).toBe("A fake idea");
    expect(noteTitle("ideas/x.md", "No heading.")).toBe("ideas/x.md");
  });
});

const splitLines = (text: string) => text.split("\n").filter((line) => line.startsWith("- "));

describe("rebuildLinks", () => {
  it("rebuilds links from the notes, so a removed link disappears", async () => {
    await inVault("vault_links", (sql) => {
      writeReflection(sql, session(), "2026-11-10T19:00:00Z");
      sql.exec("UPDATE files SET body = '# About me\n' WHERE path = 'USER.md'");
      rebuildLinks(sql);
      expect(links(sql)).toEqual([]);
    });
  });
});

describe("versions", () => {
  it("keeps who wrote each version of a note and when, and nothing for a write that changed nothing", async () => {
    await inVault("vault_versions", (sql) => {
      writeReflection(sql, session(), "2026-11-10T19:00:00Z");
      writeReflection(sql, session(), "2026-11-10T20:00:00Z");
      expect(versionsOf(sql, "USER.md").map((v) => [v.operation, v.actor])).toEqual([
        ["modified", "session:aaaaaaaa-1111-4111-8111-111111111111"],
        ["created", "seed"],
      ]);
      expect(versionsOf(sql, "USER.md")[0].at).toBe("2026-11-10T19:00:00Z");
    });
  });

  it("puts a note back to an earlier version, as a new version", async () => {
    await inVault("vault_restore", (sql) => {
      const seeded = body(sql, "USER.md");
      writeReflection(sql, session(), "2026-11-10T19:00:00Z");
      const first = versionsOf(sql, "USER.md").at(-1)!;
      expect(restoreVersion(sql, first.id, "2026-11-10T21:00:00Z")).toBe("USER.md");
      expect(body(sql, "USER.md")).toBe(seeded);
      expect(versionsOf(sql, "USER.md")[0]).toMatchObject({ operation: "modified", actor: `restore:${first.id}` });
      expect(links(sql)).toEqual([]);
      expect(restoreVersion(sql, 999_999, "2026-11-10T21:00:00Z")).toBeNull();
    });
  });

  it("drops the oldest versions of a note past the limit", async () => {
    await inVault("vault_version_cap", (sql) => {
      for (let i = 0; i < MAX_VERSIONS_PER_NOTE + 5; i++) writeFile(sql, "MEMORY.md", "memory", {}, `# Memory ${i}\n`, "2026-11-10T19:00:00Z", "consolidation");
      expect(versionsOf(sql, "MEMORY.md")).toHaveLength(MAX_VERSIONS_PER_NOTE);
    });
  });
});

describe("writeConsolidation", () => {
  it("swaps the learned lines for the tidied ones and leaves the user's own text alone", async () => {
    await inVault("vault_consolidate", (sql) => {
      const about = splitLearned(body(sql, "USER.md")).about;
      writeReflection(sql, session({ reflection: { items: [], summary: "First chat.", facts: ["Works nights", "Has a fake dog"], lessons: ["Lists land better than paragraphs"] } }), "2026-11-10T19:00:00Z");
      expect(readLearned(sql)).toEqual({ facts: ["Works nights", "Has a fake dog"], lessons: ["Lists land better than paragraphs"] });

      writeConsolidation(sql, { facts: ["Works days since November 2026", "Has a fake dog"], lessons: [] }, "2026-11-12T09:00:00Z");
      expect(readLearned(sql)).toEqual({ facts: ["Works days since November 2026", "Has a fake dog"], lessons: [] });
      expect(splitLearned(body(sql, "USER.md")).about).toBe(about);
      expect(versionsOf(sql, "USER.md")[0]).toMatchObject({ actor: "consolidation" });
      expect(links(sql)).toEqual([]);
    });
  });
});
