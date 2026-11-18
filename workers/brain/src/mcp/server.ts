import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import type { Brief, NotePatch, UserBrain } from "../brain";
import { filterEvents, filterTasks, renderItems, renderNote } from "../items";
import { renderTopic } from "../prompt";
import type { Rpc } from "../types";
import {
  ADD_EVENT_TOOL,
  ADD_TASK_TOOL,
  CAPTURE_TOOL,
  LIST_EVENTS_TOOL,
  LIST_TASKS_TOOL,
  OPEN_BRAIN_TOOL,
  READ_NOTE_TOOL,
  RECALL_TOOL,
  SERVER_INSTRUCTIONS,
  UPDATE_EVENT_TOOL,
  UPDATE_TASK_TOOL,
  openBrainText,
  type BrainTool,
} from "@day13/instructions";

const SERVER_NAME = "dumpling";
export const CAPTURED = "Saved. It'll be filed under topics once things go quiet.";

export const MAX_CAPTURE_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 500;
const MAX_ANSWER_CHARS = 2_000;
const MAX_QUERY_CHARS = 500;
const MAX_SESSION_NOTE_CHARS = 1_500;
const MAX_PATH_CHARS = 200;
const MAX_TITLE_CHARS = 100;
const MAX_DETAIL_CHARS = 2_000;
const MAX_LOCATION_CHARS = 80;
const MAX_PEOPLE = 5;
const MAX_PERSON_CHARS = 30;

export const NO_SUCH_TASK = "There's no to-do at that path. Call list_tasks to find it.";
export const NO_SUCH_EVENT = "There's no event at that path. Call list_events to find it.";
export const NO_SUCH_NOTE = "There's no note at that path.";
export const NOTHING_TO_CHANGE = "Nothing to change: send at least one thing besides the path.";

type Brain = Rpc<Pick<UserBrain, "getBrief" | "capture" | "recall" | "getNote" | "addItem" | "listItems" | "updateNote">>;

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
const failed = (value: string) => ({ ...text(value), isError: true });

const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/);
const dayOrTime = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);
const area = z.enum(["work", "personal"]);
const status = z.enum(["open", "done", "dropped"]);
const importance = z.enum(["low", "normal", "high"]);
const path = z.string().trim().min(1).max(MAX_PATH_CHARS);
const people = z.array(z.string().trim().min(1).max(MAX_PERSON_CHARS)).max(MAX_PEOPLE);
const NONE = "none";

/** The tool's own wording for one of its inputs, so the schema here and the one the evals test say the same thing. */
const said = (tool: BrainTool, input: string) => tool.inputSchema.properties[input]!.description;
const config = (tool: BrainTool) => ({ title: tool.title, description: tool.description, annotations: tool.annotations });

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

  server.registerTool(
    READ_NOTE_TOOL.name,
    { ...config(READ_NOTE_TOOL), inputSchema: z.object({ path: path.describe(said(READ_NOTE_TOOL, "path")) }) },
    async ({ path: notePath }) => {
      const note = await signedInBrain().getNote(withExtension(notePath));
      return note ? text(renderNote(note)) : failed(NO_SUCH_NOTE);
    },
  );

  server.registerTool(
    ADD_TASK_TOOL.name,
    {
      ...config(ADD_TASK_TOOL),
      inputSchema: z.object({
        title: z.string().trim().min(1).max(MAX_TITLE_CHARS).describe(said(ADD_TASK_TOOL, "title")),
        due: day.optional().describe(said(ADD_TASK_TOOL, "due")),
        importance: importance.optional().describe(said(ADD_TASK_TOOL, "importance")),
        area: area.optional().describe(said(ADD_TASK_TOOL, "area")),
        people: people.optional().describe(said(ADD_TASK_TOOL, "people")),
        detail: z.string().trim().max(MAX_DETAIL_CHARS).optional().describe(said(ADD_TASK_TOOL, "detail")),
      }),
    },
    async (task) => {
      const added = await signedInBrain().addItem({ kind: "task", ...task });
      return added === "invalid_item" ? failed("That to-do needs a title.") : text(`Added to their list as ${added.path}.`);
    },
  );

  server.registerTool(
    LIST_TASKS_TOOL.name,
    {
      ...config(LIST_TASKS_TOOL),
      inputSchema: z.object({
        status: status.optional().describe(said(LIST_TASKS_TOOL, "status")),
        area: area.optional().describe(said(LIST_TASKS_TOOL, "area")),
        due_by: day.optional().describe(said(LIST_TASKS_TOOL, "due_by")),
      }),
    },
    async (filter) => {
      const { notes, unfiled, today } = await signedInBrain().listItems("task");
      const wanted = filter.status ?? "open";
      return text(renderItems(`Their ${wanted} to-dos, soonest first.`, `No ${wanted} to-dos match.`, filterTasks(notes, filter), wanted === "open" ? unfiled : [], today));
    },
  );

  server.registerTool(
    UPDATE_TASK_TOOL.name,
    {
      ...config(UPDATE_TASK_TOOL),
      inputSchema: z.object({
        path: path.describe(said(UPDATE_TASK_TOOL, "path")),
        status: status.optional().describe(said(UPDATE_TASK_TOOL, "status")),
        due: z.union([day, z.literal(NONE)]).optional().describe(said(UPDATE_TASK_TOOL, "due")),
        importance: importance.optional().describe(said(UPDATE_TASK_TOOL, "importance")),
        area: area.optional().describe(said(UPDATE_TASK_TOOL, "area")),
      }),
    },
    async ({ path: notePath, due, ...rest }) => {
      const patch: NotePatch = { ...rest, ...(due === undefined ? {} : { due: due === NONE ? null : due }) };
      if (!Object.keys(patch).length) return failed(NOTHING_TO_CHANGE);
      const updated = await signedInBrain().updateNote(withExtension(notePath), patch, "task");
      return typeof updated === "string" ? failed(NO_SUCH_TASK) : text(`Updated ${updated.path}.`);
    },
  );

  server.registerTool(
    ADD_EVENT_TOOL.name,
    {
      ...config(ADD_EVENT_TOOL),
      inputSchema: z.object({
        title: z.string().trim().min(1).max(MAX_TITLE_CHARS).describe(said(ADD_EVENT_TOOL, "title")),
        start: dayOrTime.describe(said(ADD_EVENT_TOOL, "start")),
        location: z.string().trim().max(MAX_LOCATION_CHARS).optional().describe(said(ADD_EVENT_TOOL, "location")),
        area: area.optional().describe(said(ADD_EVENT_TOOL, "area")),
        people: people.optional().describe(said(ADD_EVENT_TOOL, "people")),
        detail: z.string().trim().max(MAX_DETAIL_CHARS).optional().describe(said(ADD_EVENT_TOOL, "detail")),
      }),
    },
    async (event) => {
      const added = await signedInBrain().addItem({ kind: "event", ...event });
      return added === "invalid_item" ? failed("That event needs a title and a start.") : text(`Added to what's coming up as ${added.path}.`);
    },
  );

  server.registerTool(
    LIST_EVENTS_TOOL.name,
    {
      ...config(LIST_EVENTS_TOOL),
      inputSchema: z.object({
        from: day.optional().describe(said(LIST_EVENTS_TOOL, "from")),
        to: day.optional().describe(said(LIST_EVENTS_TOOL, "to")),
        area: area.optional().describe(said(LIST_EVENTS_TOOL, "area")),
      }),
    },
    async (filter) => {
      const { notes, unfiled, today } = await signedInBrain().listItems("event");
      return text(renderItems("Their events, soonest first.", "No events match.", filterEvents(notes, filter, today), unfiled, today));
    },
  );

  server.registerTool(
    UPDATE_EVENT_TOOL.name,
    {
      ...config(UPDATE_EVENT_TOOL),
      inputSchema: z.object({
        path: path.describe(said(UPDATE_EVENT_TOOL, "path")),
        start: dayOrTime.optional().describe(said(UPDATE_EVENT_TOOL, "start")),
        location: z.string().trim().min(1).max(MAX_LOCATION_CHARS).optional().describe(said(UPDATE_EVENT_TOOL, "location")),
        status: status.optional().describe(said(UPDATE_EVENT_TOOL, "status")),
        area: area.optional().describe(said(UPDATE_EVENT_TOOL, "area")),
      }),
    },
    async ({ path: notePath, location, ...rest }) => {
      const patch: NotePatch = { ...rest, ...(location === undefined ? {} : { location: location === NONE ? null : location }) };
      if (!Object.keys(patch).length) return failed(NOTHING_TO_CHANGE);
      const updated = await signedInBrain().updateNote(withExtension(notePath), patch, "event");
      return typeof updated === "string" ? failed(NO_SUCH_EVENT) : text(`Updated ${updated.path}.`);
    },
  );

  return server;
}

/** Notes are linked as `[[tasks/abc]]`, so a path may arrive without its extension. */
const withExtension = (notePath: string) => (/\.[A-Za-z0-9]+$/.test(notePath) ? notePath : `${notePath}.md`);

const resource = new URL(env.MCP_RESOURCE);

export const mcpHandler = createMcpHandler(createBrainServer, { route: resource.pathname, allowedHostnames: [resource.hostname] });

export function renderCapture({ text: said, context, answer }: { text: string; context?: string; answer?: string }): string {
  return [said, context && `(Context: ${context})`, answer && `(The AI they asked answered: ${answer})`].filter(Boolean).join("\n");
}

/** What they've captured that isn't filed yet, then what a voice session would start from. */
export function renderBrief({ user, memory, sessionNotes, topics, recent, unfiled, time, today }: Brief): string {
  return [
    section("Captured lately, not filed yet", unfiled.length ? unfiled.map((turn) => `- ${turn.text.replaceAll("\n", " ")}`).join("\n") : "Nothing waiting."),
    section("About them (USER.md)", [`Preferences: ${JSON.stringify(user.preferences)}`, user.about.trim()].filter(Boolean).join("\n\n")),
    section("How to help them (MEMORY.md)", memory?.trim() || "Nothing yet."),
    section("Their last conversations, newest first", sessionNotes.length ? sessionNotes.map(({ path, body }) => `## ${path}\n${cut(body.trim(), MAX_SESSION_NOTE_CHARS)}`).join("\n\n") : "None yet."),
    section("Topics their notes are filed under", topics.length ? topics.map(renderTopic).join("\n") : "None yet."),
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
