/**
 * The one source of truth for how ChatGPT and Claude are told to use the brain.
 * Every surface (MCP tool descriptions, the server's `instructions`, what `open_brain` returns,
 * the Claude skill and the custom-instruction lines) is built from the text below.
 *
 * Tool names and descriptions are deliberately short and stable: users report Claude's
 * "Always allow" resetting whenever a description changes. Tune the rules in `OPEN_BRAIN_GUIDE`,
 * which the server returns at runtime, before touching a description.
 */

export const CONNECTOR_NAME = "Dumpling";

export const TOOL_NAMES = {
  open: "open_brain",
  capture: "capture",
  recall: "recall",
  readNote: "read_note",
  addTask: "add_task",
  listTasks: "list_tasks",
  updateTask: "update_task",
  addEvent: "add_event",
  listEvents: "list_events",
  updateEvent: "update_event",
} as const;

export const NEVER_STORE =
  "card or bank numbers, passwords, PINs, security or one-time codes, API keys, or passport, driving licence or National Insurance numbers";

const NEVER_STORE_SHORT = "card or bank numbers, passwords, codes or ID numbers";

interface StringProperty {
  type: "string";
  description: string;
  enum?: readonly string[];
}

interface ListProperty {
  type: "array";
  items: { type: "string" };
  description: string;
}

export type ToolProperty = StringProperty | ListProperty;

export interface BrainTool {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    required: string[];
    properties: Record<string, ToolProperty>;
  };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const OPEN_BRAIN_TOOL: BrainTool = {
  name: TOOL_NAMES.open,
  title: "Open Dumpling",
  description:
    "Open the person's Dumpling: the one memory they share across ChatGPT, Claude and their other apps. Call this at the start of every conversation, before you reply to their first message, without being asked. It returns how they want Dumpling used and what's been on their mind lately, so you can pick up where they left off.",
  inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
  annotations: readOnly,
};

export const CAPTURE_TOOL: BrainTool = {
  name: TOOL_NAMES.capture,
  title: "Save to Dumpling",
  description: `Save something the person said to their Dumpling, so it's kept and filed for them across all their apps. Call it straight away, without asking, whenever they mention something worth keeping: an idea, a plan, a decision, a question they're looking into, something to buy, cook or book, a loose list of things on their mind, or something about their life. A single clear to-do goes to add_task and a dated event to add_event instead, never both. Send their own words, lightly tidied. Dumpling sorts and tags everything later, so don't file, title or summarise it. Skip small talk and anything already saved in this conversation. Never send ${NEVER_STORE}, even if they ask: leave that part out and save the rest. Don't say you've saved it unless they ask.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", description: "What they said, in their own words. Several things can go in one capture." },
      context: { type: "string", description: "Only when their words don't make sense alone: a few words on what they refer to, like which trip 'it' is." },
      answer: { type: "string", description: "Only for a question you've answered: the gist of your answer in a sentence or two." },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

export const RECALL_TOOL: BrainTool = {
  name: TOOL_NAMES.recall,
  title: "Search Dumpling",
  description:
    "Search the person's Dumpling for anything they've said before, in any app. Call it without asking whenever they refer back to something ('that idea I had', 'what did I decide about', 'my list'), ask what they've got on, or when what they've said before would change your answer. Use a few plain words, like 'friday dinner ideas'. Returns the notes that match best.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: { query: { type: "string", description: "A few plain words to search for." } },
  },
  annotations: readOnly,
};

const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const change = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const AREA: StringProperty = { type: "string", enum: ["work", "personal"], description: "work for their job, personal for everything else. Leave out if you can't tell." };
const AREA_FILTER: StringProperty = { type: "string", enum: ["work", "personal"], description: "Only this part of their life. Leave out for both." };
const PEOPLE: ListProperty = { type: "array", items: { type: "string" }, description: "Who it's for or with, only if they said: first names or plain roles like the kids. Never a surname." };
const DETAIL: StringProperty = { type: "string", description: "Anything else they said about it, in their own words." };
const PATH: StringProperty = { type: "string", description: "The note's path, exactly as a Dumpling tool returned it." };

export const READ_NOTE_TOOL: BrainTool = {
  name: TOOL_NAMES.readNote,
  title: "Read a Dumpling note",
  description:
    "Read one note from the person's Dumpling in full. Call it when recall, list_tasks or list_events returned a note that's cut short or that you need the detail of, or to follow a [[link]] inside a note.",
  inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: PATH } },
  annotations: readOnly,
};

export const ADD_TASK_TOOL: BrainTool = {
  name: TOOL_NAMES.addTask,
  title: "Add a to-do to Dumpling",
  description: `Add one to-do to the person's Dumpling list, where it shows up straight away. Call it without asking when they clearly ask for a to-do or a reminder ('remind me to', 'I need to', 'add to my list'), once for each to-do. Give a due date only when they gave one or clearly meant one, like tomorrow or by Friday. If it isn't one clear to-do, or you're unsure, use capture instead. Never use both for the same thing. Never include ${NEVER_STORE}. Don't say you've added it unless they ask.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
      title: { type: "string", description: "The to-do in a few of their own words, starting with what to do, like 'Book the MOT'." },
      due: { type: "string", description: "The day it's due as YYYY-MM-DD. Leave out if they gave no date." },
      importance: { type: "string", enum: ["low", "normal", "high"], description: "Only if they said how much it matters." },
      area: AREA,
      people: PEOPLE,
      detail: DETAIL,
    },
  },
  annotations: write,
};

export const LIST_TASKS_TOOL: BrainTool = {
  name: TOOL_NAMES.listTasks,
  title: "List Dumpling to-dos",
  description:
    "List the person's to-dos from their Dumpling, soonest first, each with its path. Call it without asking when they ask what they've got on, what's due or what's on their list, and before update_task, to find the right to-do.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      status: { type: "string", enum: ["open", "done", "dropped"], description: "Which to-dos. Leave out for the open ones." },
      area: AREA_FILTER,
      due_by: { type: "string", description: "Only to-dos due on or before this day, as YYYY-MM-DD." },
    },
  },
  annotations: readOnly,
};

export const UPDATE_TASK_TOOL: BrainTool = {
  name: TOOL_NAMES.updateTask,
  title: "Update a Dumpling to-do",
  description:
    "Change one to-do in the person's Dumpling: tick it off, drop it, reopen it, or change when it's due, how much it matters or its area. Call it without asking when they say they've done something on their list, no longer need to, or want it moved. Find its path with list_tasks first. Send only what changes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: PATH,
      status: { type: "string", enum: ["open", "done", "dropped"], description: "done when they've done it, dropped when it's no longer needed, open to put it back." },
      due: { type: "string", description: "The new due day as YYYY-MM-DD, or 'none' to clear it." },
      importance: { type: "string", enum: ["low", "normal", "high"], description: "How much it matters now." },
      area: AREA,
    },
  },
  annotations: change,
};

export const ADD_EVENT_TOOL: BrainTool = {
  name: TOOL_NAMES.addEvent,
  title: "Add an event to Dumpling",
  description: `Add one event to the person's Dumpling: something happening on a set day that they need to be at, like an appointment, a meeting, a booking or a trip. Call it without asking as soon as they mention one with a day. With no day yet, use capture instead. Something they need to do by a date is a to-do, so use add_task for that. Never use both for the same thing. Never include ${NEVER_STORE}. Don't say you've added it unless they ask.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "start"],
    properties: {
      title: { type: "string", description: "What it is, in a few of their own words, like 'Dentist check-up'." },
      start: { type: "string", description: "When it starts, UK time: YYYY-MM-DD, or YYYY-MM-DDTHH:MM if they gave a time." },
      location: { type: "string", description: "A place name like school or the dentist, only if they said. Never an address." },
      area: AREA,
      people: PEOPLE,
      detail: DETAIL,
    },
  },
  annotations: write,
};

export const LIST_EVENTS_TOOL: BrainTool = {
  name: TOOL_NAMES.listEvents,
  title: "List Dumpling events",
  description:
    "List the person's events from their Dumpling, soonest first, each with its path. Call it without asking when they ask what's coming up, what's on a given day or when something is, and before update_event, to find the right event.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      from: { type: "string", description: "The first day to include, as YYYY-MM-DD. Leave out for today." },
      to: { type: "string", description: "The last day to include, as YYYY-MM-DD. Leave out for everything ahead." },
      area: AREA_FILTER,
    },
  },
  annotations: readOnly,
};

export const UPDATE_EVENT_TOOL: BrainTool = {
  name: TOOL_NAMES.updateEvent,
  title: "Update a Dumpling event",
  description:
    "Change one event in the person's Dumpling: move it, change where it is or its area, or drop it when it's cancelled. Call it without asking when they say an event has moved, changed or is off. Find its path with list_events first. Send only what changes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: PATH,
      start: { type: "string", description: "When it now starts, UK time: YYYY-MM-DD or YYYY-MM-DDTHH:MM." },
      location: { type: "string", description: "The new place name, or 'none' to clear it. Never an address." },
      status: { type: "string", enum: ["open", "done", "dropped"], description: "dropped when it's cancelled, done when it's happened, open to put it back." },
      area: AREA,
    },
  },
  annotations: change,
};

export const BRAIN_TOOLS: readonly BrainTool[] = [
  OPEN_BRAIN_TOOL,
  CAPTURE_TOOL,
  RECALL_TOOL,
  READ_NOTE_TOOL,
  ADD_TASK_TOOL,
  LIST_TASKS_TOOL,
  UPDATE_TASK_TOOL,
  ADD_EVENT_TOOL,
  LIST_EVENTS_TOOL,
  UPDATE_EVENT_TOOL,
];

/** ChatGPT reads this; claude.ai drops it. ChatGPT may only keep the first 512 characters, so everything that matters is up front. */
export const SERVER_INSTRUCTIONS = `Dumpling is this person's one memory across ChatGPT and Claude, and they never want to organise it. Use it without being asked. Call open_brain at the start of every conversation, before replying. One clear to-do goes to add_task, a dated event to add_event. Anything else worth keeping goes to capture in their own words: Dumpling files it. When they refer back, call recall. Never capture ${NEVER_STORE_SHORT}. Use the tools quietly and don't ask first.

open_brain returns the full guide and what's been on their mind lately. Use list_tasks and list_events for what they've got on, and update_task or update_event when something is done, moved or off. Never save the same thing twice. Capture work and personal things alike, as they come up, rather than at the end. Skip small talk and anything they say not to save.`;

/** The "how", returned by `open_brain` with the person's summary appended. It lives on the server, so it can change without touching a tool description. */
export const OPEN_BRAIN_GUIDE = `# How to use this person's Dumpling

They talk to more than one AI and don't want to file anything. Dumpling is the one place it all ends up: everything they mention is filed and tagged for them, and any AI they use can look it up. Your part is to send things in and look things up, quietly.

## Which tool saves it

Save things as they come up. Don't wait for the end of the conversation and don't ask first. Pick one tool for each thing, never two:

| They say | Use | Why |
| --- | --- | --- |
| One clear to-do or reminder: "remind me to book the MOT", "I need to email Priya by Friday" | add_task | It's on their list straight away, with its due date |
| Something happening on a day they need to be at: "dentist on Tuesday at 3", "we fly on the 12th" | add_event | It's in what's coming up straight away |
| Anything else worth keeping, or a ramble that mixes several things | capture | Dumpling splits it up, dates it and files it later |

- add_task and add_event take one thing each. For two clear to-dos, call add_task twice.
- A to-do buried in a longer thought ("thinking about the garden, should probably get a skip at some point") goes to capture with the rest. So does a plan with no day yet.
- A deadline makes a to-do, not an event. "Tax return by the 31st" is add_task with a due date.
- Work out dates from today's date under Now, below. Only give a date they gave or clearly meant. Never guess one.
- If you're unsure which tool fits, use capture. Nothing is lost that way: it's only filed a little later.
- Never send the same thing to two tools. If part of a message went to add_task or add_event, leave that part out of capture.

## Capture without asking

Call capture as soon as they mention something worth keeping that isn't one clear to-do or a dated event. Worth keeping means:

- loose lists and things on their mind
- ideas, plans and decisions
- questions they're looking into, with the gist of your answer
- meals, shopping, trips, bookings and gifts
- work things as well as personal ones, since Dumpling tags them
- things about their life that would help next time

Send their own words, lightly tidied. Don't sort, title or summarise: Dumpling does that. Several things can go in one call. If they paste something big, like a document or code, capture what they're working on in a line, not the paste.

## Don't capture

- small talk, thanks, and replies about how you answered
- anything already captured in this conversation
- anything they say not to save, or ask you to forget
- ${NEVER_STORE}

If a message mixes one of these with something worth keeping, leave the sensitive part out and capture the rest. If they ask you to save one, tell them Dumpling doesn't keep those.

## Looking things up

- Call list_tasks when they ask what they've got on, what's due or what's on their list, and list_events for what's coming up or when something is.
- Call recall whenever they refer back to anything else, or when what they've said before would change your answer. Use a few plain words. If it finds nothing, say so plainly and carry on.
- Call read_note when a result is cut short, or to follow a [[link]] in a note.

## When something is done, moved or off

When they say they've done something on their list, call list_tasks to find it, then update_task with status done. Use dropped when they no longer need to do it. When an event moves or is cancelled, find it with list_events, then call update_event. Don't ask first, and don't add a new to-do or event for something that's already there.

## Keep it quiet

Don't announce, explain or ask about Dumpling, and don't say you've saved, added or ticked off something. Answer them like someone who remembers. If they ask what you saved, tell them.

## If you have your own memory too

Keep using it as normal, but still save here: Dumpling is the memory they share across all their apps.`;

/** What `open_brain` returns: the guide, then the person's summary from the vault. */
export function openBrainText(summary: string): string {
  return `${OPEN_BRAIN_GUIDE}\n\n## What's been on their mind\n\n${summary.trim() || "Nothing yet: this is their first conversation with Dumpling."}`;
}

export const SKILL_NAME = "dumpling";

/** Claude loads a skill when its description matches the conversation, so this says when, broadly, and names the connector. */
export const SKILL_DESCRIPTION =
  "Use in every conversation where the person mentions anything from their own life or work: to-dos, reminders, ideas, plans, decisions, questions they're looking into, meals, shopping, trips or things to remember, or where they refer back to something they said before in any chat or app. Keeps their Dumpling connector up to date without being asked, and looks things up in it, so nothing they say gets lost across chats.";

export const SKILL_BODY = `# Dumpling

The person keeps one memory across all their AIs in the Dumpling connector. They don't want to organise anything or be asked about it, so use it on your own.

Dumpling's tools are \`open_brain\`, \`capture\`, \`recall\`, \`read_note\`, \`add_task\`, \`list_tasks\`, \`update_task\`, \`add_event\`, \`list_events\` and \`update_event\`. If you can't see them, search your tools for "dumpling".

1. **Open it first.** At the start of the conversation, call \`open_brain\` before you reply. It returns the full guide and what's been on their mind lately.
2. **Save as you go, with one tool per thing.** One clear to-do or reminder goes to \`add_task\`, once per to-do. Something happening on a set day goes to \`add_event\`. Everything else worth keeping (ideas, plans, decisions, questions they're looking into, meals, shopping, loose lists, anything you're unsure about) goes to \`capture\` straight away in their own words. Don't sort or summarise: Dumpling files it. Never send the same thing to two tools.
3. **Look things up.** For what they've got on or what's due, call \`list_tasks\`. For what's coming up, call \`list_events\`. When they refer to anything else from before, call \`recall\` with a few plain words.
4. **Keep the list true.** When they've done something, find it with \`list_tasks\` and call \`update_task\`. When an event moves or is off, use \`list_events\` then \`update_event\`.
5. **Never store** ${NEVER_STORE}. Leave that part out and capture the rest.
6. **Skip** small talk, thanks, replies about how you answered, and anything they say not to save.
7. **Stay quiet.** Don't announce Dumpling, ask permission or say you've saved, added or ticked off something. If they ask what you saved, tell them.

If you have your own memory too, keep using it, but still save here: Dumpling is the memory they share across apps.`;

/** A couple of lines for each app's own custom instructions, the fallback when the skill or server instructions aren't enough. */
export const CUSTOM_INSTRUCTIONS = {
  claude: `I keep one memory across all my AIs in the Dumpling connector. In every chat, call open_brain first. Without asking or telling me: put a clear to-do in add_task, a dated event in add_event, and anything else worth keeping in capture, in my words. Use list_tasks for what I've got on and recall when I refer back to something. Never save ${NEVER_STORE_SHORT}.`,
  chatgpt: `I keep one memory across all my AIs in the Dumpling app. In every chat, use Dumpling's open_brain first. Without asking or telling me: put a clear to-do in add_task, a dated event in add_event, and anything else worth keeping in capture, in my words. Use list_tasks for what I've got on and recall when I refer back to something. Never save ${NEVER_STORE_SHORT}.`,
} as const;
