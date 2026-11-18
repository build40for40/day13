import type { SearchableNote } from "./recall";

/**
 * Notes every person's assistant can look up with `recall` and nobody's conversation can change: what the product knows, as
 * opposed to what it knows about one person. They ship with the Worker, so editing them is a deploy.
 */
export const REFERENCE: SearchableNote[] = [
  {
    path: "reference/how-filing-works.md",
    body: `# How filing works

Say whatever is on your mind, in any order. Nothing needs a folder.

When the conversation ends, everything said is filed for you: ideas, questions (with the answer you got), tasks and loose thoughts each get their own note, and each note goes under a topic or two, like "garden" or "work". Topics appear on their own as you talk about things.

Ask "what did I say about the garden?" and the assistant looks through your notes. Ask "what do you know about me?" and it tells you plainly. You can read, change or delete what's kept about you at any time.
`,
  },
];
