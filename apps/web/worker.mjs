const BASE = '/dumpling/api'
const WORKOS = 'https://api.workos.com/user_management'
const CLIENT_ID = 'client_01M6E5ZDQ9XBYYE28XYN7H3XTJ'
const AGENT_ID = 'agent_3401m7q8xy4xevs910n2j7t3w5yf'

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function workos(path, data) {
  return fetch(WORKOS + path, {
    method: 'POST',
    body: new URLSearchParams({ client_id: CLIENT_ID, ...data }),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  })
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (!path.startsWith(BASE + '/')) return env.ASSETS.fetch(request)
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    try {
      if (path === BASE + '/device/start') {
        if (!env.DUMPLING_VOICE_OWNER_ID || !env.ELEVENLABS_API_KEY) return json({ error: 'voice_not_configured' }, 503)
        const upstream = await workos('/authorize/device', {})
        if (!upstream.ok) return json({ error: 'sign_in_unavailable' }, 502)
        const { device_code, user_code, verification_uri_complete, expires_in, interval } = await upstream.json()
        return json({ device_code, user_code, verification_uri_complete, expires_in, interval })
      }

      if (path === BASE + '/device/poll') {
        const { device_code } = await request.json().catch(() => ({})) ?? {}
        if (typeof device_code !== 'string' || !/^[A-Za-z0-9_-]{10,512}$/.test(device_code)) {
          return json({ error: 'invalid_device_code' }, 400)
        }
        const upstream = await workos('/authenticate', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code,
        })
        const data = await upstream.json()
        if (!upstream.ok) {
          const error = ['authorization_pending', 'slow_down', 'expired_token', 'access_denied'].includes(data.error)
            ? data.error : 'sign_in_unavailable'
          return json({ error }, upstream.status)
        }
        return json({ access_token: data.access_token })
      }

      if (path !== BASE + '/voice/session') return json({ error: 'not_found' }, 404)
      if (!env.DUMPLING_VOICE_OWNER_ID || !env.ELEVENLABS_API_KEY) return json({ error: 'voice_not_configured' }, 503)
      const authorization = request.headers.get('Authorization')
      if (!authorization?.match(/^Bearer \S+$/)) return json({ error: 'sign_in_required' }, 401)
      const profile = await env.BRAIN.fetch('https://build40for40.com/day13/api/me', { headers: { authorization } })
      if (profile.status === 401) return json({ error: 'sign_in_required' }, 401)
      if (!profile.ok) return json({ error: 'brain_unavailable' }, 502)
      const { id } = await profile.json()
      if (id !== env.DUMPLING_VOICE_OWNER_ID) return json({ error: 'voice_account_not_allowed' }, 403)

      const endpoint = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url')
      endpoint.searchParams.set('agent_id', AGENT_ID)
      const voice = await fetch(endpoint, {
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      })
      if (!voice.ok) return json({ error: 'voice_unavailable' }, 502)
      const { signed_url } = await voice.json()
      const location = new URL(signed_url)
      if (location.protocol !== 'wss:' || location.hostname !== 'api.elevenlabs.io') {
        return json({ error: 'voice_unavailable' }, 502)
      }
      return json({ signed_url })
    } catch {
      return json({ error: 'voice_unavailable' }, 502)
    }
  },
}
