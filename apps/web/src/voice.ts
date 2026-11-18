import { Conversation } from '@elevenlabs/client'
import { getAccessToken, sessionChanges, setAccessToken } from './session'

const mic = document.querySelector<HTMLButtonElement>('#mic')!
const controls = document.querySelector<HTMLDivElement>('#voice-controls')!
const status = document.querySelector<HTMLParagraphElement>('#voice-status')!
const signInButton = document.querySelector<HTMLButtonElement>('#voice-sign-in')!
const mute = document.querySelector<HTMLButtonElement>('#voice-mute')!
const preview = document.querySelector<HTMLAnchorElement>('#voice-preview')!
const api = '/dumpling/api'

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

const pendingKey = 'dumpling.sign-in'

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signIn() {
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  sessionStorage.setItem(pendingKey, JSON.stringify({ state, verifier }))
  location.assign(api + '/sign-in?' + new URLSearchParams({ state, code_challenge: challenge }))
}

async function finishSignIn() {
  const url = new URL(location.href)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!state || (!code && !url.searchParams.has('error'))) return
  for (const name of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(name)
  history.replaceState(null, '', url)

  let pending: { state?: string; verifier?: string } = {}
  try {
    pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? '{}')
    sessionStorage.removeItem(pendingKey)
  } catch {
    // Without the stored verifier the sign-in can't be finished.
  }
  try {
    if (!code || pending.state !== state) throw new Error('sign_in_unavailable')
    show('Signing in…')
    const { response, data } = await post('/sign-in/token', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: pending.verifier }),
    })
    if (!response.ok || typeof data.access_token !== 'string') throw new Error(data.error)
    setAccessToken(data.access_token)
    show('Signed in. Tap the mic to start.')
  } catch (error) {
    show(messages[error instanceof Error ? error.message : ''] ?? 'Couldn’t sign in. Tap Sign in to try again.')
  }
}

function syncSignIn() {
  signInButton.hidden = Boolean(getAccessToken())
}

sessionChanges.addEventListener('change', syncSignIn)
syncSignIn()

const messages: Record<string, string> = {
  voice_not_configured: 'Dumpling voice still needs server setup.',
  voice_account_not_allowed: 'You’re signed in, but voice is only switched on for one account for now.',
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
    const accessToken = getAccessToken()
    if (!accessToken) {
      show('Opening sign-in…')
      await signIn()
      return
    }

    show('Connecting to Dumpling…')
    const { response, data } = await post('/voice/session', { headers: { Authorization: 'Bearer ' + accessToken } })
    if (response.status === 401) {
      setAccessToken('')
      await signIn()
      return
    }
    if (!response.ok) throw new Error(data.error)

    active = await Conversation.startSession({
      signedUrl: data.signed_url,
      connectionType: 'websocket',
      onMessage({ source, message }) {
        if (source === 'user') window.dispatchEvent(new CustomEvent('dumpling:transcript', { detail: message }))
      },
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

signInButton.addEventListener('click', () => {
  if (!getAccessToken()) void signIn()
})
mic.addEventListener('dumpling:voice-toggle', () => void toggleVoice())
mute.addEventListener('click', () => {
  if (!active) return
  muted = !muted
  active.setMicMuted(muted)
  mute.textContent = muted ? 'Unmute microphone' : 'Mute microphone'
  show(muted ? 'Microphone muted.' : 'Listening…')
})
void finishSignIn()
window.addEventListener('pagehide', () => void active?.endSession())
