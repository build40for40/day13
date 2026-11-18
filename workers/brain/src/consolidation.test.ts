import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./claude";
import { consolidate, CONSOLIDATE_EVERY_SESSIONS, CONSOLIDATE_OVER_LINES, consolidationRequest, needsConsolidation } from "./consolidation";
import { isRetryable, ReflectionError } from "./reflection";
import { mockClaude } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
});

const learned = { facts: ["Works nights", "Works days since November 2026"], lessons: ["Lists land better than paragraphs"] };
const reply = (output: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(output) }] });

describe("needsConsolidation", () => {
  it("waits for enough conversations, unless a list has grown too long", () => {
    expect(needsConsolidation(learned, CONSOLIDATE_EVERY_SESSIONS - 1)).toBe(false);
    expect(needsConsolidation(learned, CONSOLIDATE_EVERY_SESSIONS)).toBe(true);
    const long = { facts: Array.from({ length: CONSOLIDATE_OVER_LINES + 1 }, (_, i) => `Fake fact ${i}`), lessons: [] };
    expect(needsConsolidation(long, 1)).toBe(true);
    expect(needsConsolidation(long, 0)).toBe(false);
    expect(needsConsolidation({ facts: [], lessons: [] }, CONSOLIDATE_EVERY_SESSIONS)).toBe(false);
  });
});

describe("consolidate", () => {
  it("asks Opus for structured output with both lists in the order they were learned", () => {
    const request = consolidationRequest(learned);
    expect(request).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high", format: { type: "json_schema" } } });
    expect(request.messages[0].content).toBe("# Facts about the person\n\n- Works nights\n- Works days since November 2026\n\n# Lessons\n\n- Lists land better than paragraphs");
  });

  it("checks and tidies what Opus returns", async () => {
    mockClaude(reply({ facts: [" Works days since   November 2026 ", "Works days since November 2026"], lessons: ["Lists land better than paragraphs", " "] }));
    const result = await consolidate(createClient(env.ANTHROPIC_API_KEY), learned);
    expect(result.learned).toEqual({ facts: ["Works days since November 2026"], lessons: ["Lists land better than paragraphs"] });
  });

  it("fails for good on output off the schema", async () => {
    mockClaude(reply({ facts: ["Works days"] }));
    const failure = await consolidate(createClient(env.ANTHROPIC_API_KEY), learned).catch((e) => e);
    expect(failure).toBeInstanceOf(ReflectionError);
    expect(isRetryable(failure)).toBe(false);
  });
});
