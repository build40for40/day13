import { describe, expect, it } from "vitest";
import * as wording from "./index.ts";
import { BRAIN_TOOLS, CUSTOM_INSTRUCTIONS, SERVER_INSTRUCTIONS, SKILL_DESCRIPTION, TOOL_NAMES, openBrainText } from "./index.ts";

function allText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allText);
  if (value && typeof value === "object") return Object.values(value).flatMap(allText);
  return [];
}

describe("the brain's wording", () => {
  it("never joins clauses with an em or en dash", () => {
    for (const text of allText(wording)) expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("puts every rule ChatGPT needs in the first 512 characters of the server instructions", () => {
    const head = SERVER_INSTRUCTIONS.slice(0, 512);
    for (const phrase of ["without being asked", "open_brain", "start of every conversation", "add_task", "add_event", "capture", "their own words", "recall", "Never capture", "passwords", "quietly"]) {
      expect(head).toContain(phrase);
    }
  });

  it("marks the reading tools read-only and the saving and changing tools as writes", () => {
    const hints = Object.fromEntries(BRAIN_TOOLS.map((t) => [t.name, t.annotations.readOnlyHint]));
    expect(hints).toEqual({
      [TOOL_NAMES.open]: true,
      [TOOL_NAMES.capture]: false,
      [TOOL_NAMES.recall]: true,
      [TOOL_NAMES.readNote]: true,
      [TOOL_NAMES.addTask]: false,
      [TOOL_NAMES.listTasks]: true,
      [TOOL_NAMES.updateTask]: false,
      [TOOL_NAMES.addEvent]: false,
      [TOOL_NAMES.listEvents]: true,
      [TOOL_NAMES.updateEvent]: false,
    });
  });

  it("tells every saving tool when to use another one instead, and never to save twice", () => {
    const description = (name: string) => BRAIN_TOOLS.find((t) => t.name === name)!.description;
    expect(description(TOOL_NAMES.capture)).toMatch(/add_task.*add_event.*never both/);
    expect(description(TOOL_NAMES.addTask)).toMatch(/use capture instead\. Never use both/);
    expect(description(TOOL_NAMES.addEvent)).toMatch(/use capture instead\..*add_task.*Never use both/);
    for (const name of [TOOL_NAMES.addTask, TOOL_NAMES.addEvent]) expect(description(name)).toMatch(/Never include card or bank numbers, passwords/);
  });

  it("names every tool in snake case and requires every field it can't do without", () => {
    for (const tool of BRAIN_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z_]*$/);
      for (const field of tool.inputSchema.required) expect(tool.inputSchema.properties).toHaveProperty(field);
    }
  });

  it("tells capture what never to store, since claude.ai drops the server instructions", () => {
    const capture = BRAIN_TOOLS.find((t) => t.name === TOOL_NAMES.capture)!;
    expect(capture.description).toMatch(/Never send card or bank numbers, passwords/);
  });

  it("keeps the skill description within Claude's limit and the custom lines short enough to paste", () => {
    expect(SKILL_DESCRIPTION.length).toBeLessThanOrEqual(1024);
    expect(CUSTOM_INSTRUCTIONS.claude.length).toBeLessThan(400);
    expect(CUSTOM_INSTRUCTIONS.chatgpt.length).toBeLessThan(400);
  });

  it("returns the guide with the person's summary, or says when there isn't one", () => {
    expect(openBrainText("Planning a garden party.")).toMatch(/## What's been on their mind\n\nPlanning a garden party\.$/);
    expect(openBrainText("  ")).toMatch(/Nothing yet/);
  });
});
