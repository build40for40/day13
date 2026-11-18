// Connects the Dumpling page to the brain. Off unless the page is opened with #connect (or already connected in this tab).
// The page itself (index.html) owns the screen; this file only loads notes into it and saves changes back.
import { BrainError, createBrain, type NotePatch } from './brain'
import { layout, londonToday } from './plan'

const KEY = 'dumpling.token'
const readToken = (): string | null => {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}
const saveToken = (t: string | null) => {
  try {
    if (t) sessionStorage.setItem(KEY, t)
    else sessionStorage.removeItem(KEY)
  } catch {
    /* private window: the token just lasts until reload */
  }
}

type Hooks = { setItems(items: ReturnType<typeof layout>, todayIso: string): void; toast(message: string): void }
declare global {
  interface Window {
    dumpling?: Hooks
    DumplingBrain?: { connected: boolean; setStatus(path: string, status: NonNullable<NotePatch['status']>): Promise<void>; dump(text: string): Promise<void>; reload(): Promise<void> }
  }
}

let token = readToken() ?? ''
const brain = createBrain({ getToken: () => token })

async function reload(): Promise<void> {
  const [tasks, events] = await Promise.all([brain.notes('task'), brain.notes('event')])
  const today = londonToday()
  window.dumpling?.setItems(layout([...tasks, ...events], today), today)
}

function signedOut(e: unknown): boolean {
  if (e instanceof BrainError && e.status === 401) {
    token = ''
    saveToken(null)
    window.dumpling?.toast('Your sign-in has expired. Connect again.')
    renderPanel()
    return true
  }
  return false
}

async function setStatus(path: string, status: NonNullable<NotePatch['status']>): Promise<void> {
  try {
    await brain.patchNote(path, { status })
  } catch (e) {
    if (!signedOut(e)) window.dumpling?.toast("Couldn't save that. It's back on the list.")
    throw e
  }
}

/** Sends what was typed as a short conversation, which the brain files into tasks once it ends. */
async function dump(text: string): Promise<void> {
  try {
    const { id } = await brain.startSession()
    for await (const event of brain.turn(id, text)) if (event.type === 'error') throw new Error(event.message)
    await brain.endSession(id)
    window.dumpling?.toast("Sent to your brain. It shows up here once it's filed.")
    setTimeout(() => void reload().catch(() => {}), 20_000)
  } catch (e) {
    if (!signedOut(e)) window.dumpling?.toast("Couldn't send that. Try again.")
    throw e
  }
}

function renderPanel(): void {
  let panel = document.getElementById('connect-panel')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'connect-panel'
    panel.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9;display:flex;gap:8px;align-items:center;justify-content:center;padding:6px 12px;background:#0b2c36;border-bottom:1px solid rgba(217,243,238,.2);font:12px Inter,system-ui,sans-serif;color:#d9f3ee'
    document.body.append(panel)
  }
  panel.replaceChildren()
  const label = document.createElement('span')
  if (token) {
    label.textContent = 'Connected to your brain'
    const out = document.createElement('button')
    out.textContent = 'Disconnect'
    out.style.cssText = 'background:none;border:0;color:#d9f3ee;text-decoration:underline;cursor:pointer;font:inherit'
    out.onclick = () => {
      token = ''
      saveToken(null)
      location.hash = ''
      location.reload()
    }
    panel.append(label, out)
  } else {
    label.textContent = 'Demo: paste a token to connect'
    const input = document.createElement('input')
    input.type = 'password'
    input.autocomplete = 'off'
    input.placeholder = 'WorkOS access token'
    input.setAttribute('aria-label', 'WorkOS access token')
    input.style.cssText = 'flex:1;min-width:0;max-width:260px;padding:4px 8px;border-radius:6px;border:1px solid rgba(217,243,238,.3);background:#07161d;color:#d9f3ee;font:inherit'
    const go = document.createElement('button')
    go.textContent = 'Connect'
    go.style.cssText = 'padding:4px 10px;border-radius:6px;border:0;background:#d9f3ee;color:#07161d;font:inherit;cursor:pointer'
    go.onclick = async () => {
      token = input.value.trim()
      if (!token) return
      try {
        await reload()
        saveToken(token)
        activate()
        renderPanel()
      } catch (e) {
        token = ''
        window.dumpling?.toast(e instanceof BrainError && e.status === 401 ? 'That token was refused.' : "Couldn't reach the brain.")
      }
    }
    panel.append(label, input, go)
  }
}

function activate(): void {
  window.DumplingBrain = { connected: true, setStatus, dump, reload }
}

if (token || location.hash === '#connect') {
  renderPanel()
  if (token) {
    activate()
    reload().catch((e) => {
      if (!signedOut(e)) window.dumpling?.toast("Couldn't reach the brain. Showing the example list.")
      window.DumplingBrain = undefined
    })
  }
}
