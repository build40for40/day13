import type { Brain, Note } from './brain'

// A fake brain for building the UI with no Worker, Claude or WorkOS. Everything here is fictional.
export const fakeNotes: Note[] = [
  { path: 'topics/gift-ideas.md', kind: 'topic', title: 'Gift ideas', updated_at: '2026-11-17T09:00:00Z', fields: {}, body: '## Filed\n- [[ideas/2026-11-02-puzzle-for-sam]]' },
  { path: 'ideas/2026-11-02-puzzle-for-sam.md', kind: 'idea', title: 'Puzzle for Sam', updated_at: '2026-11-17T09:00:00Z', fields: { area: 'personal' }, body: 'A 500 piece puzzle, something with trains.' },
  { path: 'tasks/2026-11-17-pick-up-costume.md', kind: 'task', title: 'Pick up the costume', updated_at: '2026-11-17T09:00:00Z', fields: { area: 'personal', who: 'kids', due: '2026-11-19', importance: 'high', status: 'open', location: 'school', topics: ['school'] } },
  { path: 'tasks/2026-11-17-safety-summary.md', kind: 'task', title: 'Send the safety summary to Dad', updated_at: '2026-11-17T10:00:00Z', fields: { area: 'work', due: '2026-11-18', status: 'open', topics: ['work'] } },
  { path: 'tasks/2026-11-17-call-dentist.md', kind: 'task', title: 'Call the dentist', updated_at: '2026-11-17T11:00:00Z', fields: { area: 'personal', status: 'open', topics: ['health'] } },
  { path: 'events/2026-11-17-school-concert.md', kind: 'event', title: 'School concert', updated_at: '2026-11-17T12:00:00Z', fields: { area: 'personal', who: 'kids', start: '2026-11-21T19:30', location: 'the school hall', status: 'open' } },
  { path: 'questions/2026-11-03-pasta-swap.md', kind: 'question', title: 'What swaps for pasta night?', updated_at: '2026-11-03T09:00:00Z', fields: {}, body: 'Rice bowls, or baked potatoes.' },
]

export function createFakeBrain(): Brain {
  const notes = fakeNotes.map((n) => ({ ...n, fields: { ...n.fields } }))
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
      return kind ? notes.filter((n) => n.kind === kind) : notes
    },
    async note(path) {
      const note = notes.find((n) => n.path === path)
      if (!note) throw new Error('not_found')
      return note
    },
    async patchNote(path, patch) {
      const note = notes.find((n) => n.path === path)
      if (!note || (note.kind !== 'task' && note.kind !== 'event')) throw new Error('not_found')
      const { due, importance, ...rest } = patch
      Object.assign(note.fields, rest)
      if (due !== undefined) due === null ? delete note.fields.due : (note.fields.due = due)
      if (importance !== undefined) importance === null ? delete note.fields.importance : (note.fields.importance = importance)
      if (patch.status === 'done') note.fields.completed_at = new Date().toISOString()
      return note
    },
  }
}
