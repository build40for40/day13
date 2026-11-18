import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completionMatches } from './completion'
import { separateDumplings } from './pool-physics'
import { layout } from './plan'

const html = readFileSync('index.html', 'utf8')
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!.replace(/^import .*$/gm, '')
const listeners: Array<Parameters<typeof window.addEventListener>> = []
const day = '2026-11-21'
const tasks = layout([
  { path: 'tasks/safety.md', kind: 'task', title: 'Send safety summary', fields: { area: 'work', due: day, status: 'open' }, updated_at: day },
  { path: 'tasks/dentist.md', kind: 'task', title: 'Call the dentist', fields: { area: 'personal', due: day, status: 'open' }, updated_at: day },
], day)
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click()
const submit = (text: string) => {
  document.querySelector<HTMLInputElement>('#in')!.value = text
  document.querySelector('#f')!.dispatchEvent(new Event('submit', { cancelable: true }))
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class { observe() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn() } as unknown as CanvasRenderingContext2D)
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
  })
  const original = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((...args) => { listeners.push(args); original(...args) })
  new Function('completionMatches', 'separateDumplings', script)(completionMatches, separateDumplings)
  window.DumplingBrain = { connected: true, setStatus: vi.fn().mockResolvedValue(undefined), setDue: vi.fn().mockResolvedValue(undefined), dump: vi.fn().mockResolvedValue(undefined), reload: vi.fn() }
  window.dumpling!.setItems(tasks.map(i => ({ ...i })), day)
})
afterEach(() => {
  for (const args of listeners.splice(0)) window.removeEventListener(...args)
  delete window.DumplingBrain
  delete window.dumpling
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('Cordelia interface with the current brain integration', () => {
  it('keeps sign-in and renders real task dates and Home filters', () => {
    expect(document.querySelector('#voice-sign-in')?.textContent).toContain('Sign in')
    expect(document.querySelector('#d0')?.textContent).toMatch(/21/)
    click('[data-category="Home"]')
    expect(document.querySelector('#today')?.textContent).toContain('Call dentist')
    expect(document.querySelector('#today')?.textContent).not.toContain('Safety summary')
  })
  it('saves a completion click to the brain and permits undo', async () => {
    click('[aria-label="Done: Safety summary"]')
    await vi.advanceTimersByTimeAsync(180)
    expect(window.DumplingBrain!.setStatus).toHaveBeenCalledWith('tasks/safety.md', 'done')
    expect(document.querySelector('#today')?.textContent).not.toContain('Safety summary')
    click('#donelabel'); click('#donelist .link')
    expect(window.DumplingBrain!.setStatus).toHaveBeenLastCalledWith('tasks/safety.md', 'open')
    expect(document.querySelector('#today')?.textContent).toContain('Safety summary')
  })
  it.each(['typed', 'spoken'])('saves %s completion through the same backend path', mode => {
    if (mode === 'typed') submit('Safety summary is done')
    else window.dispatchEvent(new CustomEvent('dumpling:transcript', { detail: 'Safety summary is done' }))
    expect(window.DumplingBrain!.setStatus).toHaveBeenCalledWith('tasks/safety.md', 'done')
    expect(window.DumplingBrain!.dump).not.toHaveBeenCalled()
    expect(document.querySelector('#toast')?.textContent).toContain('Popped!')
  })
  it('restores the task when saving completion fails', async () => {
    vi.mocked(window.DumplingBrain!.setStatus).mockRejectedValueOnce(new Error('offline'))
    submit('Safety summary is done')
    await Promise.resolve()
    expect(document.querySelector('#today')?.textContent).toContain('Safety summary')
  })
  it('sends new tasks to the brain and restores text on failure', async () => {
    vi.mocked(window.DumplingBrain!.dump).mockRejectedValueOnce(new Error('offline'))
    submit('Plan a fictional picnic')
    expect(window.DumplingBrain!.dump).toHaveBeenCalledWith('Plan a fictional picnic')
    await Promise.resolve()
    expect(document.querySelector<HTMLInputElement>('#in')?.value).toBe('Plan a fictional picnic')
  })
  it('saves a new due date through the shared brain connection', async () => {
    click('[aria-label="Move Send safety summary"]')
    expect(document.querySelector<HTMLDialogElement>('#task-move')!.open).toBe(true)
    document.querySelector<HTMLInputElement>('#task-move-date')!.value = '2026-11-25'
    document.querySelector('#task-move-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await Promise.resolve()
    expect(window.DumplingBrain!.setDue).toHaveBeenCalledWith('tasks/safety.md', '2026-11-25')
    expect(document.querySelector<HTMLDialogElement>('#task-move')!.open).toBe(false)
  })
  it('shows a retryable error when saving a date fails', async () => {
    vi.mocked(window.DumplingBrain!.setDue).mockRejectedValueOnce(new Error('offline'))
    click('[aria-label="Move Send safety summary"]')
    document.querySelector('#task-move-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await Promise.resolve()
    expect(document.querySelector<HTMLDialogElement>('#task-move')!.open).toBe(true)
    expect(document.querySelector('#task-move-error')!.textContent).toContain('Couldn’t move')
    expect(document.querySelector<HTMLButtonElement>('#task-move-save')!.disabled).toBe(false)
  })
  it('clears real tasks when the shared session resets and keeps categories', () => {
    window.dumpling!.resetItems()
    expect(document.querySelector<HTMLElement>('#example-label')!.hidden).toBe(false)
    expect(document.querySelector('[aria-label="Move Send safety summary"]')).toBeNull()
    expect(document.querySelector('[data-category="Home"]')).not.toBeNull()
  })

})
