import { Conversation } from '@elevenlabs/client'

const mic = document.querySelector<HTMLButtonElement>('#mic')!
const controls = document.querySelector<HTMLDivElement>('#voice-controls')!
const status = document.querySelector<HTMLParagraphElement>('#voice-status')!
const login = document.querySelector<HTMLAnchorElement>('#voice-login')!
const mute = document.querySelector<HTMLButtonElement>('#voice-mute')!
const preview = document.querySelector<HTMLAnchorElement>('#voice-preview')!
const api = '/dumpling/api'

let accessToken = ''
let active: Awaited<ReturnType<typeof Conversation.startSession>> | undefined
let busy = false
let muted = false

function show(text: string) {
  controls.hidden = !text
  status.textContent = text
  preview.hidden = true
}

function setCallState(connected: boolean) {
  mic.dataset.voiceActive = String(connected)
  mic.classList.toggle('listening', connected)
  mic.dispatchEvent(new Event('dumpling:voice-state'))
  mute.hidden = !connected
  mute.textContent = 'Mute microphone'
  muted = false
}

async function post(path: string, init: RequestInit = {}) {
  const response = await fetch(api + path, { ...init, method: 'POST', cache: 'no-store' })
  return { response, data: await response.json() }
}

async function signIn() {
  const { response, data } = await post('/device/start')
  if (!response.ok) throw new Error(data.error)
  const url = new URL(data.verification_uri_complete)
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.authkit.app')) throw new Error('sign_in_unavailable')

  login.href = url.href
  login.hidden = false
  show('Sign in with WorkOS and confirm code ' + data.user_code + '.')
  const deadline = Date.now() + data.expires_in * 1000
  let interval = Math.max(data.interval ?? 5, 5) * 1000
  try {
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, interval))
      if (Date.now() >= deadline) break
      const result = await post('/device/poll', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: data.device_code }),
      })
      if (result.response.ok && typeof result.data.access_token === 'string') {
        accessToken = result.data.access_token
        show('Signed in. Tap the mic to start.')
        return
      }
      if (result.data.error === 'slow_down') interval += 5000
      else if (result.data.error !== 'authorization_pending') throw new Error(result.data.error)
    }
    throw new Error('expired_token')
  } finally {
    login.hidden = true
    login.removeAttribute('href')
  }
}

const messages: Record<string, string> = {
  voice_not_configured: 'Dumpling voice still needs server setup.',
  voice_account_not_allowed: 'This WorkOS account does not have access to this voice demo.',
  expired_token: 'The sign-in expired. Tap the mic to try again.',
  NotAllowedError: 'Allow microphone access for this site, then tap the mic again.',
}

async function toggleVoice() {
  if (busy) return
  busy = true
  try {
    if (active) {
      await active.endSession()
      active = undefined
      setCallState(false)
      show('Call ended.')
      return
    }
    if (!accessToken) {
      show('Preparing WorkOS sign-in…')
      await signIn()
      return
    }

    show('Connecting to Dumpling…')
    const { response, data } = await post('/voice/session', { headers: { Authorization: 'Bearer ' + accessToken } })
    if (response.status === 401) {
      accessToken = ''
      await signIn()
      return
    }
    if (!response.ok) throw new Error(data.error)

    active = await Conversation.startSession({
      signedUrl: data.signed_url,
      connectionType: 'websocket',
      onDisconnect() {
        active = undefined
        setCallState(false)
        show('Call ended.')
      },
      onError() {
        show('The voice connection had a problem.')
      },
      onModeChange({ mode }) {
        if (active) show(muted ? 'Microphone muted.' : mode === 'speaking' ? 'Dumpling is speaking…' : 'Listening…')
      },
    })
    setCallState(true)
    show('Listening…')
  } catch (error) {
    const key = error instanceof Error ? (error.name === 'Error' ? error.message : error.name) : ''
    show(messages[key] ?? 'Couldn’t start Dumpling voice. Tap the mic to try again.')
    preview.hidden = key !== 'voice_not_configured'
  } finally {
    busy = false
  }
}

mic.addEventListener('dumpling:voice-toggle', () => void toggleVoice())
mute.addEventListener('click', () => {
  if (!active) return
  muted = !muted
  active.setMicMuted(muted)
  mute.textContent = muted ? 'Unmute microphone' : 'Mute microphone'
  show(muted ? 'Microphone muted.' : 'Listening…')
})
window.addEventListener('pagehide', () => void active?.endSession())
