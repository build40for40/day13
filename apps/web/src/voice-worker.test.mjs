import { afterEach, expect, test, vi } from 'vitest'
import worker from '../worker.mjs'

const endpoint = 'https://example.com/dumpling/api/voice/session'
const signedUrl = 'wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=fixture'
const env = (id = 'user_owner') => ({
  DUMPLING_VOICE_OWNER_ID: 'user_owner',
  ELEVENLABS_API_KEY: 'fictional-key',
  BRAIN: { fetch: vi.fn(async () => Response.json({ id })) },
})
const request = (headers) => new Request(endpoint, { method: 'POST', headers })

afterEach(() => vi.unstubAllGlobals())

test('returns an unavailable response when the voice Worker secrets are missing', async () => {
  const response = await worker.fetch(request(), {})
  expect(response.status).toBe(503)
})

test('never requests a signed URL without a matching brain owner', async () => {
  const issuer = vi.fn()
  vi.stubGlobal('fetch', issuer)
  expect((await worker.fetch(request(), env())).status).toBe(401)
  const otherUser = env('user_other')
  expect((await worker.fetch(request({ Authorization: 'Bearer fixture' }), otherUser)).status).toBe(403)
  expect(otherUser.BRAIN.fetch).toHaveBeenCalledOnce()
  expect(issuer).not.toHaveBeenCalled()
})

test('returns only a non-cacheable signed URL to the verified account', async () => {
  const issuer = vi.fn(async () => Response.json({ signed_url: signedUrl, internal: 'ignored' }))
  vi.stubGlobal('fetch', issuer)
  const response = await worker.fetch(request({ Authorization: 'Bearer fixture' }), env())
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(await response.json()).toEqual({ signed_url: signedUrl })
  expect(issuer.mock.calls[0][1].headers).toEqual({ 'xi-api-key': 'fictional-key' })
})
