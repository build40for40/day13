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

export const TOOL_NAMES = { open: "open_brain", capture: "capture", recall: "recall" } as const;

export const NEVER_STORE =
  "card or bank numbers, passwords, PINs, security or one-time codes, API keys, or passport, driving licence or National Insurance numbers";

const NEVER_STORE_SHORT = "card or bank numbers, passwords, codes or ID numbers";

interface StringProperty {
  type: "string";
  description: string;
}

export interface BrainTool {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    required: string[];
    properties: Record<string, StringProperty>;
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
  description: `Save something the person said to their Dumpling, so it's kept and filed for them across all their apps. Call it straight away, without asking, whenever they mention something worth keeping: a to-do, an idea, a plan, a decision, a question they're looking into, something to buy, cook or book, or something about their life. Send their own words, lightly tidied. Dumpling sorts and tags everything later, so don't file, title or summarise it. Skip small talk and anything already saved in this conversation. Never send ${NEVER_STORE}, even if they ask: leave that part out and save the rest. Don't say you've saved it unless they ask.`,
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

export const BRAIN_TOOLS: readonly BrainTool[] = [OPEN_BRAIN_TOOL, CAPTURE_TOOL, RECALL_TOOL];

/** ChatGPT reads this; claude.ai drops it. ChatGPT may only keep the first 512 characters, so everything that matters is up front. */
export const SERVER_INSTRUCTIONS = `Dumpling is this person's one memory across ChatGPT and Claude, and they never want to organise it. Use it without being asked. Call open_brain at the start of every conversation, before replying. Whenever they mention a to-do, idea, plan, question they're looking into or anything worth keeping, call capture with their own words: Dumpling files it. When they refer back to something, call recall. Never capture ${NEVER_STORE_SHORT}. Use the tools quietly and don't ask first.

open_brain returns the full guide and what's been on their mind lately. Capture work and personal things alike, as they come up, rather than at the end. Skip small talk and anything they say not to save.`;

/** The "how", returned by `open_brain` with the person's summary appended. It lives on the server, so it can change without touching a tool description. */
export const OPEN_BRAIN_GUIDE = `# How to use this person's Dumpling

They talk to more than one AI and don't want to file anything. Dumpling is the one place it all ends up: everything they mention is filed and tagged for them, and any AI they use can look it up. Your part is to send things in and look things up, quietly.

## Capture without asking

Call capture as soon as they mention something worth keeping. Don't wait for the end of the conversation and don't ask first. Worth keeping means:

- to-dos and reminders, however small
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

## Recall

Call recall whenever they refer back to something, ask what they've got on, or when what they've said before would change your answer. Use a few plain words. If it finds nothing, say so plainly and carry on.

## Keep it quiet

Don't announce, explain or ask about Dumpling, and don't say you've saved something. Answer them like someone who remembers. If they ask what you saved, tell them.

## If you have your own memory too

Keep using it as normal, but still capture here: Dumpling is the memory they share across all their apps.`;

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

Dumpling's tools are \`open_brain\`, \`capture\` and \`recall\`. If you can't see them, search your tools for "dumpling".

1. **Open it first.** At the start of the conversation, call \`open_brain\` before you reply. It returns the full guide and what's been on their mind lately.
2. **Capture as you go.** Whenever they mention a to-do, idea, plan, decision, a question they're looking into, meals, shopping, trips, work or anything else worth keeping, call \`capture\` straight away with their own words. Don't sort or summarise: Dumpling files it. Several things can go in one call.
3. **Recall when they look back.** When they refer to something from before, or ask what they've got on, call \`recall\` with a few plain words.
4. **Never store** ${NEVER_STORE}. Leave that part out and capture the rest.
5. **Skip** small talk, thanks, replies about how you answered, and anything they say not to save.
6. **Stay quiet.** Don't announce Dumpling, ask permission or say you've saved something. If they ask what you saved, tell them.

If you have your own memory too, keep using it, but still capture here: Dumpling is the memory they share across apps.`;

/** A couple of lines for each app's own custom instructions, the fallback when the skill or server instructions aren't enough. */
export const CUSTOM_INSTRUCTIONS = {
  claude: `I keep one memory across all my AIs in the Dumpling connector. In every chat, call open_brain first. Save anything I mention that's worth keeping with capture, in my words, without asking or telling me. Use recall when I refer back to something. Never save ${NEVER_STORE_SHORT}.`,
  chatgpt: `I keep one memory across all my AIs in the Dumpling app. In every chat, use Dumpling's open_brain first. Save anything I mention that's worth keeping with Dumpling's capture, in my words, without asking or telling me. Use recall when I refer back to something. Never save ${NEVER_STORE_SHORT}.`,
} as const;
