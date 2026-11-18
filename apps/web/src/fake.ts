import type { Brain, Note } from './brain'

// A fake brain for building the UI with no Worker, Claude or WorkOS. Everything here is fictional.
export const fakeNotes: Note[] = [
  { path: 'topics/gift-ideas.md', kind: 'topic', title: 'Gift ideas', body: '## Filed\n- [[ideas/2026-11-02-puzzle-for-sam]]' },
  { path: 'ideas/2026-11-02-puzzle-for-sam.md', kind: 'idea', title: 'Puzzle for Sam', body: 'A 500 piece puzzle, something with trains.' },
  { path: 'tasks/2026-11-03-pick-up-costume.md', kind: 'task', title: 'Pick up the costume', body: 'Before Friday.' },
  { path: 'questions/2026-11-03-pasta-swap.md', kind: 'question', title: 'What swaps for pasta night?', body: 'Rice bowls, or baked potatoes.' },
]

export function createFakeBrain(): Brain {
  return {
    async startSession() {
      return { id: 'fake-session', started_at: new Date().toISOString(), opening_line: 'What is on your mind?' }
    },
    async *turn(_id, text) {
      for (const word of `Noted: ${text}`.split(' ')) yield { type: 'text', delta: word + ' ' }
      yield { type: 'done', session_ended: false }
    },
    async endSession() {
      return 'filing'
    },
    async notes(kind) {
      return kind ? fakeNotes.filter((n) => n.kind === kind) : fakeNotes
    },
    async note(path) {
      const note = fakeNotes.find((n) => n.path === path)
      if (!note) throw new Error('not_found')
      return note
    },
  }
}
