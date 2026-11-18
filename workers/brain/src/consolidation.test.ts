import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./claude";
import { consolidate, CONSOLIDATE_EVERY_SESSIONS, CONSOLIDATE_OVER_LINES, consolidationRequest, needsConsolidation, type VaultState } from "./consolidation";
import { isRetryable, ReflectionError } from "./reflection";
import { mockClaude } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
});

const learned = { facts: ["Works nights", "Works days since November 2026"], lessons: ["Lists land better than paragraphs"] };
const vault: VaultState = {
  topics: [
    { name: "garden", items: 4, summary: "The fake shed is half painted." },
    { name: "gardening", items: 1, summary: "" },
    { name: "fake trip", items: 2, summary: "" },
  ],
  untopiced: [{ path: "tasks/2026-11-18-book-the-fake-mot.md", title: "Book the fake MOT" }],
};
const reply = (output: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(output) }] });

describe("needsConsolidation", () => {
  it("waits for enough conversations, unless a list has grown too long", () => {
    expect(needsConsolidation(learned, CONSOLIDATE_EVERY_SESSIONS - 1)).toBe(false);
    expect(needsConsolidation(learned, CONSOLIDATE_EVERY_SESSIONS)).toBe(true);
    const long = { facts: Array.from({ length: CONSOLIDATE_OVER_LINES + 1 }, (_, i) => `Fake fact ${i}`), lessons: [] };
    expect(needsConsolidation(long, 1)).toBe(true);
    expect(needsConsolidation(long, 0)).toBe(false);
    expect(needsConsolidation({ facts: [], lessons: [] }, CONSOLIDATE_EVERY_SESSIONS)).toBe(false);
    expect(needsConsolidation({ facts: [], lessons: [] }, CONSOLIDATE_EVERY_SESSIONS, vault)).toBe(true);
    expect(needsConsolidation({ facts: [], lessons: [] }, CONSOLIDATE_EVERY_SESSIONS, { topics: vault.topics.slice(0, 1), untopiced: [] })).toBe(false);
  });
});

describe("consolidate", () => {
  it("asks Opus for structured output with both lists in the order they were learned", () => {
    const request = consolidationRequest(learned);
    expect(request).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high", format: { type: "json_schema" } } });
    expect(request.messages[0].content).toBe("# Facts about the person\n\n- Works nights\n- Works days since November 2026\n\n# Lessons\n\n- Lists land better than paragraphs");
  });

  it("checks and tidies what Opus returns", async () => {
    mockClaude(reply({ facts: [" Works days since   November 2026 ", "Works days since November 2026"], lessons: ["Lists land better than paragraphs", " "], topic_merges: [], topic_filings: [] }));
    const result = await consolidate(createClient(env.ANTHROPIC_API_KEY), learned);
    expect(result.learned).toEqual({ facts: ["Works days since November 2026"], lessons: ["Lists land better than paragraphs"] });
  });

  it("shows the topics and the items under none, only when there are some", () => {
    const content = consolidationRequest(learned, vault).messages[0].content as string;
    expect(content).toContain("# Topics\n\n- garden (4 items): The fake shed is half painted.\n- gardening (1 item)\n- fake trip (2 items)");
    expect(content).toContain("# Items filed under no topic\n\n- tasks/2026-11-18-book-the-fake-mot.md: Book the fake MOT");
  });

  it("keeps only merges between listed topics, without chains, and filings for listed items", async () => {
    mockClaude(
      reply({
        facts: [],
        lessons: [],
        topic_merges: [
          { from: " Gardening ", into: "garden" },
          { from: "garden", into: "fake trip" },
          { from: "fake trip", into: "fake trip" },
          { from: "made up", into: "garden" },
        ],
        topic_filings: [
          { path: "tasks/2026-11-18-book-the-fake-mot.md", topics: [" Car ", "car", "admin", "home", "extra"] },
          { path: "tasks/2026-11-18-book-the-fake-mot.md", topics: ["twice"] },
          { path: "tasks/not-listed.md", topics: ["car"] },
        ],
      }),
    );
    const { tidying } = await consolidate(createClient(env.ANTHROPIC_API_KEY), learned, vault);
    expect(tidying).toEqual({ topic_merges: [{ from: "gardening", into: "garden" }], topic_filings: [{ path: "tasks/2026-11-18-book-the-fake-mot.md", topics: ["car", "admin", "home"] }] });
  });

  it("fails for good on output off the schema", async () => {
    mockClaude(reply({ facts: ["Works days"] }));
    const failure = await consolidate(createClient(env.ANTHROPIC_API_KEY), learned).catch((e) => e);
    expect(failure).toBeInstanceOf(ReflectionError);
    expect(isRetryable(failure)).toBe(false);
  });
});
