// A typed client for the brain Worker (workers/brain/README.md is the spec). No UI in here.

export type NoteKind = 'user' | 'memory' | 'session' | 'idea' | 'question' | 'task' | 'event' | 'thought' | 'topic'

export type Session = { id: string; started_at: string; opening_line?: string }

/** What the brain files with a task or event. Only the fields that are set are there. */
export type NoteFields = {
  area?: 'work' | 'personal'
  who?: 'kids' | 'grown-ups'
  /** YYYY-MM-DD */
  due?: string
  /** YYYY-MM-DD or YYYY-MM-DDTHH:MM, London time */
  start?: string
  location?: string
  importance?: 'low' | 'normal' | 'high'
  status?: 'open' | 'done' | 'dropped'
  completed_at?: string
  /** Which of area, due and importance the assistant worked out rather than was told. */
  inferred?: string[]
  topics?: string[]
}

export type Note = { path: string; kind: NoteKind; title: string; updated_at: string; fields: NoteFields; body?: string; linked_from?: string[] }

/** What can be changed on a task or event. `null` clears a field. */
export type NotePatch = { status?: 'open' | 'done' | 'dropped'; due?: string | null; importance?: 'low' | 'normal' | 'high' | null; area?: 'work' | 'personal' }

export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; session_ended: boolean }
  | { type: 'error'; message: string }

export type Brain = {
  startSession(): Promise<Session>
  /** Streams the reply. Nothing is saved from a turn that errors, so the caller can resend it. */
  turn(sessionId: string, text: string): AsyncIterable<TurnEvent>
  endSession(sessionId: string): Promise<'filing' | 'nothing_said'>
  notes(kind?: NoteKind): Promise<Note[]>
  note(path: string): Promise<Note>
  /** Marks a task done, changes its date, and so on. */
  patchNote(path: string, patch: NotePatch): Promise<Note>
}

export class BrainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export function createBrain(opts: { baseUrl?: string; getToken: () => string | Promise<string>; fetch?: typeof fetch }): Brain {
  const base = opts.baseUrl ?? '/day13/api'
  const doFetch = opts.fetch ?? fetch.bind(globalThis)

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await doFetch(base + path, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${await opts.getToken()}`, 'content-type': 'application/json' },
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new BrainError(res.status, body.error ?? 'unknown')
    }
    return res
  }

  return {
    async startSession() {
      return (await call('/sessions', { method: 'POST' })).json()
    },
    async *turn(sessionId, text) {
      const res = await call(`/sessions/${sessionId}/turns`, { method: 'POST', body: JSON.stringify({ text }) })
      yield* parseSse(res.body!)
    },
    async endSession(sessionId) {
      const res = await call(`/sessions/${sessionId}/end`, { method: 'POST' })
      return res.status === 204 ? 'nothing_said' : 'filing'
    },
    async notes(kind) {
      const res = await call(`/notes${kind ? `?kind=${kind}` : ''}`)
      const data = (await res.json()) as Note[] | { notes: Note[] }
      return Array.isArray(data) ? data : data.notes
    },
    async note(path) {
      return (await call(`/notes/${path}`)).json()
    },
    async patchNote(path, patch) {
      return (await call(`/notes/${path}`, { method: 'PATCH', body: JSON.stringify(patch) })).json()
    },
  }
}

/** Parses `event:`/`data:` server-sent events into turn events. */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncIterable<TurnEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let type = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!data) continue
      const payload = JSON.parse(data) as Record<string, unknown>
      yield { type, ...payload } as TurnEvent
    }
  }
}
