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

const pkce = 'a'.repeat(43)

test('sends sign-in to WorkOS with the PKCE challenge and the page as the redirect', async () => {
  const start = `https://example.com/dumpling/api/sign-in?state=${pkce}&code_challenge=${pkce}`
  const response = await worker.fetch(new Request(start), env())
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('Location'))
  expect(location.origin + location.pathname).toBe('https://api.workos.com/user_management/authorize')
  expect(location.searchParams.get('redirect_uri')).toBe('https://example.com/dumpling/')
  expect(location.searchParams.get('code_challenge')).toBe(pkce)
  expect(location.searchParams.get('state')).toBe(pkce)
  expect((await worker.fetch(new Request(start.replace(pkce, 'short')), env())).status).toBe(400)
})

test('trades the sign-in code for an access token for any account', async () => {
  const exchange = vi.fn(async () => Response.json({ access_token: 'fixture-token', refresh_token: 'ignored' }))
  vi.stubGlobal('fetch', exchange)
  const token = (body) => new Request('https://example.com/dumpling/api/sign-in/token', { method: 'POST', body: JSON.stringify(body) })
  const body = { code: 'fixture-code', code_verifier: pkce }

  const response = await worker.fetch(token(body), env())
  expect(await response.json()).toEqual({ access_token: 'fixture-token' })
  expect(Object.fromEntries(new URLSearchParams(exchange.mock.calls[0][1].body))).toMatchObject({ grant_type: 'authorization_code', ...body })

  expect((await worker.fetch(token(body), env('user_other'))).status).toBe(200)
  expect((await worker.fetch(token({ code: 'fixture-code' }), env())).status).toBe(400)
})
