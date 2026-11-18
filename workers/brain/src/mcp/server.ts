import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import type { UserBrain } from "../brain";
import type { ContextSources } from "../prompt";
import type { Rpc } from "../types";
import { CAPTURE_TOOL, OPEN_BRAIN_TOOL, RECALL_TOOL, SERVER_INSTRUCTIONS, openBrainText } from "@day13/instructions";

const SERVER_NAME = "dumpling";
export const CAPTURED = "Saved. It'll be filed under topics once things go quiet.";

export const MAX_CAPTURE_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 500;
const MAX_ANSWER_CHARS = 2_000;
const MAX_QUERY_CHARS = 500;
const MAX_SESSION_NOTE_CHARS = 1_500;

type Brain = Rpc<Pick<UserBrain, "getBrief" | "capture" | "recall">>;

/** What the OAuth token was issued with, from `completeAuthorization()` at sign-in. */
export interface McpProps extends Record<string, unknown> {
  sub: string;
}

function signedInBrain(): Brain {
  const sub = getMcpAuthContext()?.props.sub;
  if (typeof sub !== "string" || !sub) throw new Error("Not signed in.");
  return env.USER_BRAIN.get(env.USER_BRAIN.idFromName(sub)) as unknown as Brain;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** A new server per request: clients share one MCP session across chats and send no conversation id, so nothing is kept between calls. */
export function createBrainServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    OPEN_BRAIN_TOOL.name,
    { title: OPEN_BRAIN_TOOL.title, description: OPEN_BRAIN_TOOL.description, annotations: OPEN_BRAIN_TOOL.annotations },
    async () => text(openBrainText(renderBrief(await signedInBrain().getBrief()))),
  );

  const captureInputs = CAPTURE_TOOL.inputSchema.properties;
  server.registerTool(
    CAPTURE_TOOL.name,
    {
      title: CAPTURE_TOOL.title,
      description: CAPTURE_TOOL.description,
      inputSchema: z.object({
        text: z.string().trim().min(1).max(MAX_CAPTURE_CHARS).describe(captureInputs.text.description),
        context: z.string().trim().max(MAX_CONTEXT_CHARS).optional().describe(captureInputs.context.description),
        answer: z.string().trim().max(MAX_ANSWER_CHARS).optional().describe(captureInputs.answer.description),
      }),
      annotations: CAPTURE_TOOL.annotations,
    },
    async (captured) => {
      await signedInBrain().capture(renderCapture(captured));
      return text(CAPTURED);
    },
  );

  server.registerTool(
    RECALL_TOOL.name,
    {
      title: RECALL_TOOL.title,
      description: RECALL_TOOL.description,
      inputSchema: z.object({ query: z.string().trim().min(1).max(MAX_QUERY_CHARS).describe(RECALL_TOOL.inputSchema.properties.query.description) }),
      annotations: RECALL_TOOL.annotations,
    },
    async ({ query }) => text(await signedInBrain().recall(query)),
  );

  return server;
}

const resource = new URL(env.MCP_RESOURCE);

export const mcpHandler = createMcpHandler(createBrainServer, { route: resource.pathname, allowedHostnames: [resource.hostname] });

export function renderCapture({ text: said, context, answer }: { text: string; context?: string; answer?: string }): string {
  return [said, context && `(Context: ${context})`, answer && `(The AI they asked answered: ${answer})`].filter(Boolean).join("\n");
}

/** What a voice session would start from: who they are, what's been learned and how their notes are filed. */
export function renderBrief({ user, memory, sessionNotes, topics, recent, time, today }: ContextSources): string {
  return [
    section("About them (USER.md)", [`Preferences: ${JSON.stringify(user.preferences)}`, user.about.trim()].filter(Boolean).join("\n\n")),
    section("How to help them (MEMORY.md)", memory?.trim() || "Nothing yet."),
    section("Their last conversations, newest first", sessionNotes.length ? sessionNotes.map(({ path, body }) => `## ${path}\n${cut(body.trim(), MAX_SESSION_NOTE_CHARS)}`).join("\n\n") : "None yet."),
    section("Topics their notes are filed under", topics.length ? topics.map((t) => `- ${t.path} (${t.items} ${t.items === 1 ? "item" : "items"})`).join("\n") : "None yet."),
    section("Newest filed items", recent.length ? recent.map((r) => `- ${r.path}: ${r.title}`).join("\n") : "None yet."),
    section("Now", `It's ${time} on ${today}, UK time.`),
  ].join("\n\n");
}

function section(title: string, body: string): string {
  return `### ${title}\n\n${body}`;
}

function cut(body: string, max: number): string {
  return body.length > max ? `${body.slice(0, max)}\n[cut short]` : body;
}
