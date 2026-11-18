import { z } from "zod";
import type { NotePatch, UserBrain } from "./brain";
import { filterEvents, filterTasks, renderItems, renderNote } from "./items";
import {
  ADD_EVENT_TOOL,
  ADD_TASK_TOOL,
  LIST_EVENTS_TOOL,
  LIST_TASKS_TOOL,
  READ_NOTE_TOOL,
  UPDATE_EVENT_TOOL,
  UPDATE_TASK_TOOL,
  type BrainTool,
} from "@day13/instructions";

export type ItemBrain = Pick<UserBrain, "getNote" | "addItem" | "listItems" | "updateNote">;
type ActionBrain = { [K in keyof ItemBrain]: (...args: Parameters<ItemBrain[K]>) => ReturnType<ItemBrain[K]> | Promise<ReturnType<ItemBrain[K]>> };
export type ActionResult = { text: string; isError?: true; changed?: true };
type RegisterAction = (tool: BrainTool, schema: z.ZodObject, run: (input: unknown) => Promise<ActionResult>) => void;

const ok = (text: string): ActionResult => ({ text });
const changed = (text: string): ActionResult => ({ text, changed: true });
const failed = (text: string): ActionResult => ({ text, isError: true });

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

/** Notes are linked as `[[tasks/abc]]`, so a path may arrive without its extension. */
const withExtension = (notePath: string) => (/\.[A-Za-z0-9]+$/.test(notePath) ? notePath : `${notePath}.md`);

export function registerItemActions(brain: () => ActionBrain, bind: RegisterAction): void {
  function register<S extends z.ZodObject>(tool: BrainTool, schema: S, run: (input: z.output<S>) => Promise<ActionResult>) {
    bind(tool, schema, async (input) => {
      const parsed = schema.safeParse(input);
      return parsed.success ? run(parsed.data) : failed("Invalid input for " + tool.name + ".");
    });
  }

  register(
    READ_NOTE_TOOL,
    z.object({ path: path.describe(said(READ_NOTE_TOOL, "path")) }),
    async ({ path: notePath }) => {
      const note = await brain().getNote(withExtension(notePath));
      return note ? ok(renderNote(note)) : failed(NO_SUCH_NOTE);
    },
  );

  register(
    ADD_TASK_TOOL,
    z.object({
        title: z.string().trim().min(1).max(MAX_TITLE_CHARS).describe(said(ADD_TASK_TOOL, "title")),
        due: day.optional().describe(said(ADD_TASK_TOOL, "due")),
        importance: importance.optional().describe(said(ADD_TASK_TOOL, "importance")),
        area: area.optional().describe(said(ADD_TASK_TOOL, "area")),
        people: people.optional().describe(said(ADD_TASK_TOOL, "people")),
        detail: z.string().trim().max(MAX_DETAIL_CHARS).optional().describe(said(ADD_TASK_TOOL, "detail")),
      }),
    async (task) => {
      const added = await brain().addItem({ kind: "task", ...task });
      return added === "invalid_item" ? failed("That to-do needs a title.") : changed(`Added to their list as ${added.path}.`);
    },
  );

  register(
    LIST_TASKS_TOOL,
    z.object({
        status: status.optional().describe(said(LIST_TASKS_TOOL, "status")),
        area: area.optional().describe(said(LIST_TASKS_TOOL, "area")),
        due_by: day.optional().describe(said(LIST_TASKS_TOOL, "due_by")),
      }),
    async (filter) => {
      const { notes, unfiled, today } = await brain().listItems("task");
      const wanted = filter.status ?? "open";
      return ok(renderItems(`Their ${wanted} to-dos, soonest first.`, `No ${wanted} to-dos match.`, filterTasks(notes, filter), wanted === "open" ? unfiled : [], today));
    },
  );

  register(
    UPDATE_TASK_TOOL,
    z.object({
        path: path.describe(said(UPDATE_TASK_TOOL, "path")),
        status: status.optional().describe(said(UPDATE_TASK_TOOL, "status")),
        due: z.union([day, z.literal(NONE)]).optional().describe(said(UPDATE_TASK_TOOL, "due")),
        importance: importance.optional().describe(said(UPDATE_TASK_TOOL, "importance")),
        area: area.optional().describe(said(UPDATE_TASK_TOOL, "area")),
      }),
    async ({ path: notePath, due, ...rest }) => {
      const patch: NotePatch = { ...rest, ...(due === undefined ? {} : { due: due === NONE ? null : due }) };
      if (!Object.keys(patch).length) return failed(NOTHING_TO_CHANGE);
      const updated = await brain().updateNote(withExtension(notePath), patch, "task");
      return typeof updated === "string" ? failed(NO_SUCH_TASK) : changed(`Updated ${updated.path}.`);
    },
  );

  register(
    ADD_EVENT_TOOL,
    z.object({
        title: z.string().trim().min(1).max(MAX_TITLE_CHARS).describe(said(ADD_EVENT_TOOL, "title")),
        start: dayOrTime.describe(said(ADD_EVENT_TOOL, "start")),
        location: z.string().trim().max(MAX_LOCATION_CHARS).optional().describe(said(ADD_EVENT_TOOL, "location")),
        area: area.optional().describe(said(ADD_EVENT_TOOL, "area")),
        people: people.optional().describe(said(ADD_EVENT_TOOL, "people")),
        detail: z.string().trim().max(MAX_DETAIL_CHARS).optional().describe(said(ADD_EVENT_TOOL, "detail")),
      }),
    async (event) => {
      const added = await brain().addItem({ kind: "event", ...event });
      return added === "invalid_item" ? failed("That event needs a title and a start.") : changed(`Added to what's coming up as ${added.path}.`);
    },
  );

  register(
    LIST_EVENTS_TOOL,
    z.object({
        from: day.optional().describe(said(LIST_EVENTS_TOOL, "from")),
        to: day.optional().describe(said(LIST_EVENTS_TOOL, "to")),
        area: area.optional().describe(said(LIST_EVENTS_TOOL, "area")),
      }),
    async (filter) => {
      const { notes, unfiled, today } = await brain().listItems("event");
      return ok(renderItems("Their events, soonest first.", "No events match.", filterEvents(notes, filter, today), unfiled, today));
    },
  );

  register(
    UPDATE_EVENT_TOOL,
    z.object({
        path: path.describe(said(UPDATE_EVENT_TOOL, "path")),
        start: dayOrTime.optional().describe(said(UPDATE_EVENT_TOOL, "start")),
        location: z.string().trim().min(1).max(MAX_LOCATION_CHARS).optional().describe(said(UPDATE_EVENT_TOOL, "location")),
        status: status.optional().describe(said(UPDATE_EVENT_TOOL, "status")),
        area: area.optional().describe(said(UPDATE_EVENT_TOOL, "area")),
      }),
    async ({ path: notePath, location, ...rest }) => {
      const patch: NotePatch = { ...rest, ...(location === undefined ? {} : { location: location === NONE ? null : location }) };
      if (!Object.keys(patch).length) return failed(NOTHING_TO_CHANGE);
      const updated = await brain().updateNote(withExtension(notePath), patch, "event");
      return typeof updated === "string" ? failed(NO_SUCH_EVENT) : changed(`Updated ${updated.path}.`);
    },
  );

}

export const liveItemTools = [READ_NOTE_TOOL, ADD_TASK_TOOL, LIST_TASKS_TOOL, UPDATE_TASK_TOOL, ADD_EVENT_TOOL, LIST_EVENTS_TOOL, UPDATE_EVENT_TOOL];

export function itemActionRunner(brain: ItemBrain) {
  const actions = new Map<string, (input: unknown) => Promise<ActionResult>>();
  registerItemActions(() => brain, (tool, _schema, run) => actions.set(tool.name, run));
  return (name: string, input: unknown) => actions.get(name)?.(input);
}
