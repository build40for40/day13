import { CUSTOM_INSTRUCTIONS, SERVER_INSTRUCTIONS, SKILL_DESCRIPTION } from "@day13/instructions";
import { describe, expect, it } from "vitest";
import { VARIANTS, buildSurface } from "./variants.ts";

describe("buildSurface", () => {
  it("leaves the server instructions out on Claude, which drops them, and puts them in on ChatGPT", () => {
    expect(buildSurface(VARIANTS["claude-tools"]!).system).not.toContain(SERVER_INSTRUCTIONS);
    expect(buildSurface(VARIANTS["chatgpt"]!).system).toContain(SERVER_INSTRUCTIONS);
  });

  it("lists the skill and adds a tool to load it", () => {
    const surface = buildSurface(VARIANTS["claude-skill"]!);
    expect(surface.system).toContain(SKILL_DESCRIPTION);
    expect(surface.roles).toMatchObject({ Skill: "skill" });
  });

  it("adds each surface's own custom instruction lines", () => {
    expect(buildSurface(VARIANTS["claude-custom"]!).system).toContain(CUSTOM_INSTRUCTIONS.claude);
    expect(buildSurface(VARIANTS["chatgpt-custom"]!).system).toContain(CUSTOM_INSTRUCTIONS.chatgpt);
  });

  it("renames and strips the tools for the bare variant but keeps their roles", () => {
    const surface = buildSurface(VARIANTS["claude-bare-tools"]!);
    expect(surface.roles).toEqual({ open: "open", save: "capture", search: "recall" });
    expect(JSON.stringify(surface.tools)).not.toMatch(/Brain|without asking/);
  });

  it("hides the brain behind tool search when deferred", () => {
    const { tools } = buildSurface(VARIANTS["claude-tools-deferred"]!);
    expect(tools.flatMap((t) => ("defer_loading" in t && t.defer_loading && "name" in t ? [t.name] : []))).toEqual(["open_brain", "capture", "recall"]);
    expect(tools.at(-1)).toEqual({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" });
  });

  it("adds a competing memory tool", () => {
    expect(buildSurface(VARIANTS["claude-skill-memory"]!).roles).toMatchObject({ memory: "memory" });
  });
});
