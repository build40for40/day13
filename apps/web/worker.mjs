const BASE = '/dumpling/api'
const WORKOS = 'https://api.workos.com/user_management'
const CLIENT_ID = 'client_01M6E5ZDQ9XBYYE28XYN7H3XTJ'
const PKCE_VALUE = /^[A-Za-z0-9_-]{43}$/
const AGENT_ID = 'agent_3401m7q8xy4xevs910n2j7t3w5yf'

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function workos(path, data) {
  return fetch(WORKOS + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...data }).toString(),
    signal: AbortSignal.timeout(10_000),
    redirect: 'manual',
  })
}

async function startCall(env, authorization) {
  if (!authorization?.match(/^Bearer \S+$/)) return { denied: json({ error: 'sign_in_required' }, 401) }
  const call = await env.BRAIN.fetch('https://build40for40.com/day13/api/voice/calls', { method: 'POST', headers: { authorization } })
  if (call.status === 401) return { denied: json({ error: 'sign_in_required' }, 401) }
  if (!call.ok) return { denied: json({ error: 'brain_unavailable' }, 502) }
  const { id, call_token } = await call.json()
  return { session_id: id, call_token }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (!path.startsWith(BASE + '/')) return env.ASSETS.fetch(request)
    if (path === BASE + '/sign-in' && request.method === 'GET') {
      const { searchParams } = new URL(request.url)
      const state = searchParams.get('state') ?? ''
      const challenge = searchParams.get('code_challenge') ?? ''
      if (!PKCE_VALUE.test(state) || !PKCE_VALUE.test(challenge)) return json({ error: 'invalid_sign_in' }, 400)
      const authorize = new URL(WORKOS + '/authorize')
      authorize.search = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: new URL('/dumpling/', request.url).href,
        response_type: 'code',
        provider: 'authkit',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString()
      return new Response(null, { status: 302, headers: { Location: authorize.href, 'Cache-Control': 'no-store' } })
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    try {
      if (path === BASE + '/sign-in/token') {
        const { code, code_verifier } = await request.json().catch(() => ({})) ?? {}
        if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{10,512}$/.test(code) || typeof code_verifier !== 'string' || !PKCE_VALUE.test(code_verifier)) {
          return json({ error: 'invalid_sign_in' }, 400)
        }
        const upstream = await workos('/authenticate', { grant_type: 'authorization_code', code, code_verifier })
        if (!upstream.ok) return json({ error: 'sign_in_unavailable' }, upstream.status === 400 ? 400 : 502)
        const data = await upstream.json()
        if (typeof data.access_token !== 'string') return json({ error: 'sign_in_unavailable' }, 502)
        return json({ access_token: data.access_token })
      }

      if (path !== BASE + '/voice/session') return json({ error: 'not_found' }, 404)
      if (!env.ELEVENLABS_API_KEY) return json({ error: 'voice_not_configured' }, 503)
      const { denied, ...call } = await startCall(env, request.headers.get('Authorization'))
      if (denied) return denied

      const endpoint = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url')
      endpoint.searchParams.set('agent_id', AGENT_ID)
      const voice = await fetch(endpoint, {
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      })
      if (!voice.ok) return json({ error: 'voice_unavailable' }, 502)
      const { signed_url } = await voice.json()
      const location = new URL(signed_url)
      if (location.protocol !== 'wss:' || location.hostname !== 'api.elevenlabs.io') {
        return json({ error: 'voice_unavailable' }, 502)
      }
      return json({ signed_url, ...call })
    } catch (cause) {
      const signInPath = path === BASE + '/sign-in/token'
      console.warn('Dumpling voice upstream failure', { phase: signInPath ? 'workos' : 'voice', name: cause?.name })
      return json({ error: signInPath ? 'sign_in_unavailable' : 'voice_unavailable' }, 502)
    }
  },
}
