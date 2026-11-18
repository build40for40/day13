import type Anthropic from "@anthropic-ai/sdk";

/**
 * The tools Claude can call during a live turn. They all run inside the Durable Object.
 * Strict schemas reject `minLength` and friends, so limits live in the descriptions and are checked in `turn.ts`.
 */
export const tools = [
  {
    name: "note",
    description: "Save one lasting fact about the person, worth remembering in future conversations. It's kept for later; they don't see it.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["fact"],
      properties: {
        fact: { type: "string", description: "One short fact, in plain words. Never empty." },
      },
    },
  },
  {
    name: "recall",
    description: "Look something up in your notes on this person and in the reference notes, when what you were given at the start doesn't cover it. Returns the notes that match best.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "A few plain words to search for. Never empty." },
      },
    },
  },
] as const satisfies readonly Anthropic.Tool[];
