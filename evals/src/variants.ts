import type Anthropic from "@anthropic-ai/sdk";
import { BRAIN_TOOLS, CONNECTOR_NAME, CUSTOM_INSTRUCTIONS, SERVER_INSTRUCTIONS, SKILL_DESCRIPTION, SKILL_NAME, TOOL_NAMES, type BrainTool } from "@day13/instructions";

export type Role = "open" | "capture" | "recall" | "memory" | "skill";

/** One way the brain could reach the model. Each field is a lever the team can pull; the eval compares them. */
export interface Variant {
  name: string;
  /** claude: tool descriptions only, since claude.ai drops server instructions. chatgpt: server instructions too. */
  surface: "claude" | "chatgpt";
  /** descriptive: our names and descriptions. bare: what a quickly written server would expose. */
  naming: "descriptive" | "bare";
  /** The skill is listed and can be loaded, as the Claude plugin would do. */
  skill: boolean;
  /** The lines from CUSTOM_INSTRUCTIONS are in the person's preferences. */
  customInstructions: boolean;
  /** A competing built-in memory tool is there too. */
  builtInMemory: boolean;
  /** The brain's tools are hidden behind tool search, as Claude's apps load connectors. */
  deferred: boolean;
}

const base = { surface: "claude", naming: "descriptive", skill: false, customInstructions: false, builtInMemory: false, deferred: false } as const;

export const VARIANTS: Record<string, Variant> = Object.fromEntries(
  (
    [
      { ...base, name: "claude-bare-tools", naming: "bare" },
      { ...base, name: "claude-tools" },
      { ...base, name: "claude-custom", customInstructions: true },
      { ...base, name: "claude-skill", skill: true },
      { ...base, name: "claude-skill-custom", skill: true, customInstructions: true },
      { ...base, name: "claude-skill-memory", skill: true, builtInMemory: true },
      { ...base, name: "claude-tools-deferred", deferred: true },
      { ...base, name: "claude-skill-deferred", skill: true, deferred: true },
      { ...base, name: "chatgpt", surface: "chatgpt" },
      { ...base, name: "chatgpt-custom", surface: "chatgpt", customInstructions: true },
      { ...base, name: "chatgpt-memory", surface: "chatgpt", builtInMemory: true },
    ] satisfies Variant[]
  ).map((v) => [v.name, v]),
);

export const TODAY = "Wednesday 18 November 2026";

const BARE: Record<string, { name: string; description: string }> = {
  [TOOL_NAMES.open]: { name: "open", description: "Open." },
  [TOOL_NAMES.capture]: { name: "save", description: "Save text." },
  [TOOL_NAMES.recall]: { name: "search", description: "Search saved text." },
};

const ROLE_OF: Record<string, Role> = { [TOOL_NAMES.open]: "open", [TOOL_NAMES.capture]: "capture", [TOOL_NAMES.recall]: "recall" };

export interface Surface {
  system: string;
  tools: Anthropic.ToolUnion[];
  /** Which part each tool name plays, so scoring doesn't depend on naming. */
  roles: Record<string, Role>;
}

function toTool(tool: BrainTool, naming: Variant["naming"], deferred: boolean): Anthropic.Tool {
  const bare = naming === "bare" ? BARE[tool.name] : undefined;
  const properties = Object.fromEntries(
    Object.entries(tool.inputSchema.properties).map(([key, prop]) => [key, bare ? { type: prop.type } : prop]),
  );
  return {
    name: bare?.name ?? tool.name,
    description: bare?.description ?? tool.description,
    input_schema: { ...tool.inputSchema, properties },
    ...(deferred ? { defer_loading: true } : {}),
  };
}

const MEMORY_TOOL: Anthropic.Tool = {
  name: "memory",
  description: "Your own built-in memory of this person. Save something about them so you remember it in future chats.",
  input_schema: { type: "object", additionalProperties: false, required: ["fact"], properties: { fact: { type: "string", description: "What to remember." } } },
};

const SKILL_TOOL: Anthropic.Tool = {
  name: "Skill",
  description: "Load a skill's full instructions by name.",
  input_schema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", description: "The skill's name." } } },
};

const TOOL_SEARCH: Anthropic.ToolSearchToolBm25_20251119 = { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" };

/** A stand-in for each app's own system prompt, which we can't see. Kept neutral so the brain's wording does the work. */
function appPrompt(surface: Variant["surface"]): string {
  return surface === "claude"
    ? `You are Claude, an AI assistant made by Anthropic, chatting with someone in the Claude app. Today is ${TODAY}. They have connected these apps: ${CONNECTOR_NAME}.`
    : `You are a helpful assistant chatting with someone in a chat app. Today is ${TODAY}. They have connected the ${CONNECTOR_NAME} app.`;
}

export function buildSurface(variant: Variant): Surface {
  const brain = BRAIN_TOOLS.map((t) => toTool(t, variant.naming, variant.deferred));
  const roles: Record<string, Role> = Object.fromEntries(BRAIN_TOOLS.map((t, i) => [brain[i]!.name, ROLE_OF[t.name]!]));
  const tools: Anthropic.ToolUnion[] = [...brain];
  const sections = [appPrompt(variant.surface)];

  if (variant.surface === "chatgpt") sections.push(`# Instructions from the ${CONNECTOR_NAME} app\n\n${SERVER_INSTRUCTIONS}`);
  if (variant.skill) {
    sections.push(`# Skills\n\nSkills hold instructions for particular situations. When a skill's description matches the conversation, load it with the Skill tool before you reply.\n\n- ${SKILL_NAME}: ${SKILL_DESCRIPTION}`);
    tools.push(SKILL_TOOL);
    roles[SKILL_TOOL.name] = "skill";
  }
  if (variant.builtInMemory) {
    sections.push("You have your own memory of this person across chats. Use the memory tool to remember things about them.");
    tools.push(MEMORY_TOOL);
    roles[MEMORY_TOOL.name] = "memory";
  }
  if (variant.deferred) tools.push(TOOL_SEARCH);
  if (variant.customInstructions) sections.push(`# What they've asked you to keep in mind\n\n${CUSTOM_INSTRUCTIONS[variant.surface]}`);

  return { system: sections.join("\n\n"), tools, roles };
}
