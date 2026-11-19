import { describe, expect, it } from 'vitest'
import { BrainError, createBrain, parseSse } from './brain'
import { createFakeBrain } from './fake'

const sse = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text))
      c.close()
    },
  })

async function collect<T>(it: AsyncIterable<T>) {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('parseSse', () => {
  it('turns events into typed turn events', async () => {
    const events = await collect(parseSse(sse('event: text\ndata: {"delta":"Hi"}\n\nevent: done\ndata: {"session_ended":false}\n\n')))
    expect(events).toEqual([
      { type: 'text', delta: 'Hi' },
      { type: 'done', session_ended: false },
    ])
  })
})

describe('createBrain', () => {
  it('sends the bearer token and raises the error code', async () => {
    let auth = ''
    const brain = createBrain({
      getToken: () => 'tok',
      fetch: (async (_url: string, init: RequestInit) => {
        auth = (init.headers as Record<string, string>).authorization!
        return new Response(JSON.stringify({ error: 'sign_in_required' }), { status: 401 })
      }) as unknown as typeof fetch,
    })
    await expect(brain.startSession()).rejects.toEqual(new BrainError(401, 'sign_in_required'))
    expect(auth).toBe('Bearer tok')
  })

  it('treats 204 on end as nothing said', async () => {
    const brain = createBrain({ getToken: () => 't', fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch })
    expect(await brain.endSession('s')).toBe('nothing_said')
  })
})

describe('fake brain', () => {
  it('streams a reply and filters notes by kind', async () => {
    const brain = createFakeBrain()
    const events = await collect(brain.turn('s', 'hello'))
    expect(events.at(-1)).toEqual({ type: 'done', session_ended: false })
    expect((await brain.notes('task')).every((n) => n.kind === 'task')).toBe(true)
  })
})

describe('patching a note', () => {
  it('sends only what changed, as JSON, to the note', async () => {
    let seen: { url: string; method?: string; body?: string } | null = null
    const brain = createBrain({
      getToken: () => 't',
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, method: init.method, body: init.body as string }
        return new Response(JSON.stringify({ path: 'tasks/x.md', kind: 'task', title: 'x', updated_at: 'now', fields: { status: 'done' } }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const note = await brain.patchNote('tasks/x.md', { status: 'done' })
    expect(seen).toEqual({ url: '/day13/api/notes/tasks/x.md', method: 'PATCH', body: '{"status":"done"}' })
    expect(note.fields.status).toBe('done')
  })

  it('raises the error code when the brain refuses', async () => {
    const brain = createBrain({ getToken: () => 't', fetch: (async () => new Response(JSON.stringify({ error: 'not_a_task' }), { status: 409 })) as unknown as typeof fetch })
    await expect(brain.patchNote('USER.md', { status: 'done' })).rejects.toEqual(new BrainError(409, 'not_a_task'))
  })
})

describe('the fake brain keeps the filing fields', () => {
  it('lists tasks with their fields and marks one done', async () => {
    const brain = createFakeBrain()
    const tasks = await brain.notes('task')
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.every((t) => t.fields.status === 'open')).toBe(true)
    const done = await brain.patchNote(tasks[0]!.path, { status: 'done' })
    expect(done.fields).toMatchObject({ status: 'done', completed_at: expect.any(String) })
  })
})
