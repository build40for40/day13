import { BrainError, createBrain, type NotePatch } from './brain'
import { layout, londonToday } from './plan'

import { getAccessToken, sessionChanges, setAccessToken } from './session'

type Hooks = { setItems(items: ReturnType<typeof layout>, todayIso: string): void; toast(message: string): void; resetItems(): void }
declare global {
  interface Window {
    dumplingView?: Hooks
    DumplingBrain?: { connected: boolean; setStatus(path: string, status: NonNullable<NotePatch['status']>): Promise<void>; setDue(path: string, due: string): Promise<void>; dump(text: string): Promise<void>; reload(): Promise<void> }
  }
}

const brain = createBrain({ getToken: getAccessToken })

let latestLoad = 0
async function reload(): Promise<void> {
  const token = getAccessToken()
  if (!token) return
  const load = ++latestLoad
  const [tasks, events] = await Promise.all([brain.notes('task'), brain.notes('event')])
  if (token !== getAccessToken() || load !== latestLoad) return
  const today = londonToday()
  window.dumplingView?.setItems(layout([...tasks, ...events], today), today)
}

function signedOut(e: unknown): boolean {
  if (e instanceof BrainError && e.status === 401) {
    setAccessToken('')
    window.dumplingView?.toast('Your sign-in has expired. Sign in again.')
    return true
  }
  return false
}

async function setStatus(path: string, status: NonNullable<NotePatch['status']>): Promise<void> {
  try {
    await brain.patchNote(path, { status })
  } catch (e) {
    if (!signedOut(e)) window.dumplingView?.toast("Couldn't save that. It's back on the list.")
    throw e
  }
}

async function setDue(path: string, due: string): Promise<void> {
  try {
    await brain.patchNote(path, { due })
  } catch (error) {
    signedOut(error)
    throw error
  }
  try {
    await reload()
  } catch (error) {
    if (!signedOut(error)) window.dumplingView?.toast('Date saved to the Brain. Reload to update the list.')
  }
}

/** Sends what was typed as a short conversation, which the brain files into tasks once it ends. */
async function dump(text: string): Promise<void> {
  try {
    const { id } = await brain.startSession()
    for await (const event of brain.turn(id, text)) if (event.type === 'error') throw new Error(event.message)
    await brain.endSession(id)
    window.dumplingView?.toast("Sent to your brain. It shows up here once it's filed.")
    setTimeout(() => void reload().catch(() => {}), 20_000)
  } catch (e) {
    if (!signedOut(e)) window.dumplingView?.toast("Couldn't send that. Try again.")
    throw e
  }
}

async function syncSession(): Promise<void> {
  const token = getAccessToken()
  window.DumplingBrain = undefined
  window.dumplingView?.resetItems()
  if (!token) return
  try {
    await reload()
    if (token === getAccessToken()) window.DumplingBrain = { connected: true, setStatus, setDue, dump, reload }
  } catch (error) {
    if (token === getAccessToken() && !signedOut(error)) {
      window.dumplingView?.toast("Couldn't reach the Brain. Reload to try again.")
    }
  }
}

sessionChanges.addEventListener('change', () => void syncSession())
void syncSession()
