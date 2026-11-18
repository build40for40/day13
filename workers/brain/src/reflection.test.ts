import { env } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./claude";
import { draft, draftRequest, isRetryable, reflect, ReflectionError, reflectionRequest, renderInput, renderLog, tidyItems, type LoggedLine, type ReflectionInput } from "./reflection";
import { fakeDraft, fakeReflection, mockClaude, noTaskFields } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
});

const VOICE = "voice:aaaaaaaa-1111-4111-8111-111111111111";
const entries: LoggedLine[] = [
  { source: VOICE, role: "user", at: "2026-11-10T18:00:00Z", text: "Keep it short please.", tool_calls: [] },
  { source: VOICE, role: "assistant", at: "2026-11-10T18:00:02Z", text: "Will do.", tool_calls: [{ id: "toolu_1", name: "note", input: { fact: "Prefers short answers" } }] },
  { source: "app:Fake Chat", role: "user", at: "2026-11-10T18:01:00Z", text: "Book the fake dentist.", tool_calls: [] },
];

const input: ReflectionInput = { user: { preferences: {}, about: "# About me" }, memory: "# Memory\n\n## Lessons\n\n- Jokes about fake trains go down well\n", topics: ["garden", "work"], entries };

const reply = (output: unknown) => ({ content: [{ type: "text" as const, text: typeof output === "string" ? output : JSON.stringify(output) }] });

describe("reflectionRequest", () => {
  it("asks Opus for structured output with everything the reflection reads", () => {
    const request = reflectionRequest(input);
    expect(request).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high", format: { type: "json_schema" } } });
    expect(request).not.toHaveProperty("thinking");
    expect(request).not.toHaveProperty("tool_choice");
    const content = request.messages[0].content as string;
    expect(content).toContain("# About me");
    expect(content).toContain("- Jokes about fake trains go down well");
    expect(content).toContain("# Existing topics\n\n- garden\n- work");
    expect(content).toContain("User: Keep it short please.");
    expect(content).toContain("# Facts the assistant noted\n\n- Prefers short answers");
    expect(content).not.toContain("# Already filed from this log");
  });

  it("shows what an earlier pass filed from the same log, and which of it the person has changed", () => {
    const content = reflectionRequest({ ...input, filed: [{ kind: "task", title: "Book the fake dentist", changed: false }, { kind: "idea", title: "A fake shed cinema", changed: true }] }).messages[0].content as string;
    expect(content).toContain("# Already filed from this log\n\n- Book the fake dentist (task)\n- A fake shed cinema (idea): they've since changed this one themselves, so leave it out");
  });
});

describe("draftRequest", () => {
  it("asks Sonnet for the items only", () => {
    const request = draftRequest(input);
    expect(request).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "medium", format: { type: "json_schema", schema: { required: ["summary", "items"] } } } });
    expect(request.system).toContain("This log is still open");
    expect(request.system).toContain("don't mention the log");
  });
});

describe("renderLog", () => {
  it("writes who said what, when and where, and the tools the assistant used", () => {
    expect(renderLog(entries)).toBe(
      ["[18:00, voice call aaaaaaaa] User: Keep it short please.", "[18:00, voice call aaaaaaaa] Assistant: Will do.", '[18:00, voice call aaaaaaaa] (Assistant used note {"fact":"Prefers short answers"})', "[18:01, Fake Chat] User: Book the fake dentist."].join("\n"),
    );
  });
});

describe("draft", () => {
  it("tidies the items and leaves facts and lessons for the settle pass", async () => {
    mockClaude(reply(fakeDraft));
    const { reflection } = await draft(createClient(env.ANTHROPIC_API_KEY), input);
    expect(reflection).toMatchObject({ summary: "Dumped a few fake things. Ended happy.", facts: [], lessons: [] });
    expect(reflection.items.map((item) => item.title)).toEqual(["A fake shed cinema", "How long does fake paint take to dry?"]);
  });

  it("won't take a full reflection", async () => {
    mockClaude(reply(fakeReflection));
    expect(await draft(createClient(env.ANTHROPIC_API_KEY), input).catch((e) => e)).toBeInstanceOf(ReflectionError);
  });
});

describe("reflect", () => {
  const client = () => createClient(env.ANTHROPIC_API_KEY);

  it("checks and tidies what Opus returns", async () => {
    mockClaude(reply(fakeReflection));
    const { reflection } = await reflect(client(), input);
    expect(reflection).toEqual({
      summary: "Dumped a few fake things. Ended happy.",
      items: [
        { kind: "idea", title: "A fake shed cinema", detail: "Turn the fake shed into a tiny cinema.", answer: "", topics: ["garden", "weekend projects"], ...noTaskFields },
        { kind: "question", title: "How long does fake paint take to dry?", detail: "Asked about drying times.", answer: "About four fake hours.", topics: ["garden"], ...noTaskFields },
      ],
      pages: [{ kind: "topic", name: "garden", summary: "Planning to turn the fake shed into a cinema. Paint is next.", project: true }],
      facts: ["Has a fake shed"],
      lessons: ["Short answers land best"],
    });
  });

  it("shows each topic and person with the summary their page has so far", () => {
    const content = renderInput({ ...input, topicSummaries: { garden: "The fake shed is half painted." }, people: [{ name: "Maya", summary: "Their fake sister." }, { name: "the kids", summary: "" }] });
    expect(content).toContain("# Existing topics\n\n- garden: The fake shed is half painted.\n- work");
    expect(content).toContain("# People who already have a page\n\n- Maya: Their fake sister.\n- the kids");
  });

  it("won't retry a refusal, output that isn't JSON or output off the schema", async () => {
    const badItem = { ...fakeReflection, items: [{ ...fakeReflection.items[0], kind: "poem" }] };
    for (const bad of [{ content: [], stop_reason: "refusal" as const }, reply("not json"), reply({ summary: "No list." }), reply({ ...fakeReflection, extra: true }), reply(badItem)]) {
      mockClaude(bad);
      const failure = await reflect(client(), input).catch((e) => e);
      expect(failure).toBeInstanceOf(ReflectionError);
      expect(isRetryable(failure)).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it("retries when Claude is down, rate limited or unreachable, and not when the request itself is wrong", () => {
    const apiError = (status: number) => Anthropic.APIError.generate(status, { type: "error", error: { type: "api_error", message: "fake" } }, "fake", new Headers());
    for (const status of [408, 409, 429, 500, 529]) expect(isRetryable(apiError(status))).toBe(true);
    for (const status of [400, 401, 403, 404]) expect(isRetryable(apiError(status))).toBe(false);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("tidyItems", () => {
  it("keeps at most three topics and clips long text", () => {
    const [item] = tidyItems([{ kind: "thought", title: "t".repeat(150), detail: "d", answer: "", topics: ["a", "b", "c", "d"], ...noTaskFields }]);
    expect(item.title).toHaveLength(100);
    expect(item.topics).toEqual(["a", "b", "c"]);
  });
});
