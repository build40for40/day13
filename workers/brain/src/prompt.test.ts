import { describe, expect, it } from "vitest";
import { assembleContext, LIVE_PROMPT, OPENING_LINE } from "./prompt";

describe("LIVE_PROMPT", () => {
  it("tells Claude about both of its tools", () => {
    for (const word of ["Call note", "Call recall"]) expect(LIVE_PROMPT).toContain(word);
  });

  it("asks for replies that read aloud", () => {
    expect(LIVE_PROMPT).toContain("Every reply is read aloud.");
  });
});

describe("assembleContext", () => {
  const base = {
    user: { preferences: { language: "en" }, about: "# About me\n\nFake person.\n" },
    memory: null,
    sessionNotes: [],
    topics: [],
    recent: [],
    reference: ["reference/how-filing-works.md"],
    time: "14:05",
    today: "18 November 2026",
  };

  it("lays out the profile, memory, earlier conversations, the filing, the reference notes and the time", () => {
    expect(assembleContext(base)).toBe(
      [
        '# USER.md\n\nPreferences: {"language":"en"}\n\n# About me\n\nFake person.',
        "# MEMORY.md\n\nNothing yet.",
        "# Your last conversations, newest first\n\nNone yet: this is the first time you've talked.",
        "# Topics their notes are filed under\n\nNone yet.",
        "# Newest filed items\n\nNone yet.",
        "# Reference notes recall can look up\n\n- reference/how-filing-works.md",
        `# This conversation\n\nIt started at 14:05 on 18 November 2026, UK time. You opened with "${OPENING_LINE}"`,
      ].join("\n\n"),
    );
  });

  it("lists topics with their sizes and the newest items", () => {
    const context = assembleContext({
      ...base,
      topics: [
        { path: "topics/garden.md", items: 3 },
        { path: "topics/work.md", items: 1 },
      ],
      recent: [{ path: "ideas/2026-11-18-a-fake-shed-cinema.md", title: "A fake shed cinema" }],
    });
    expect(context).toContain("# Topics their notes are filed under\n\n- topics/garden.md (3 items)\n- topics/work.md (1 item)");
    expect(context).toContain("# Newest filed items\n\n- ideas/2026-11-18-a-fake-shed-cinema.md: A fake shed cinema");
  });

  it("includes earlier session notes and cuts long ones short", () => {
    const context = assembleContext({
      ...base,
      memory: "Lesson one.",
      sessionNotes: [
        { path: "sessions/2026-11-17-bbbbbbbb.md", frontmatter: '{"date":"2026-11-17"}', body: "# Conversation\n\nSecond.\n" },
        { path: "sessions/2026-11-16-aaaaaaaa.md", frontmatter: "{}", body: "x".repeat(7_000) },
      ],
    });
    expect(context).toContain("# MEMORY.md\n\nLesson one.");
    expect(context).toContain('## sessions/2026-11-17-bbbbbbbb.md\nfrontmatter: {"date":"2026-11-17"}\n# Conversation\n\nSecond.');
    expect(context).toContain(`${"x".repeat(6_000)}\n[cut short]`);
    expect(context).not.toContain("x".repeat(6_001));
  });

  it("gives the same bytes for the same input, so the prompt cache holds", () => {
    expect(assembleContext(base)).toBe(assembleContext(structuredClone(base)));
  });
});
