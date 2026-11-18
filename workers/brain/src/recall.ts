export interface SearchableNote {
  path: string;
  body: string;
}

export const MAX_RECALL_NOTES = 4;
const MAX_EXCERPT_CHARS = 1_500;
const MAX_QUERY_WORDS = 8;

const words = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];

/** The notes that mention the most words of the query, best first. Plain word matching: a vault is a few dozen short notes. */
export function search(notes: SearchableNote[], query: string, limit = MAX_RECALL_NOTES): SearchableNote[] {
  const wanted = words(query).slice(0, MAX_QUERY_WORDS);
  if (!wanted.length) return [];
  return notes
    .map((note) => {
      const text = `${note.path}\n${note.body}`.toLowerCase();
      return { note, score: wanted.filter((word) => text.includes(word)).length };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path))
    .slice(0, limit)
    .map((hit) => hit.note);
}

/** What `recall` hands back to Claude. */
export function renderRecall(notes: SearchableNote[]): string {
  if (!notes.length) return "Nothing in your notes matches that.";
  return notes.map(({ path, body }) => `## ${path}\n${body.length > MAX_EXCERPT_CHARS ? `${body.slice(0, MAX_EXCERPT_CHARS)}\n[cut short]` : body.trim()}`).join("\n\n");
}
