import { describe, expect, it } from 'vitest'
import type { Note, NoteFields } from './brain'
import { daysUntil, layout, londonToday, quota, reefFor, shorten, toItem } from './plan'

// Wednesday 18 November 2026. Everything here is fictional.
const WED = '2026-11-18'
const SAT = '2026-11-21'

let n = 0
const task = (title: string, fields: NoteFields = {}, kind: Note['kind'] = 'task'): Note => ({ path: `tasks/fake-${++n}.md`, kind, title, updated_at: `2026-11-1${n % 8}T09:00:00Z`, fields: { area: 'personal', status: 'open', ...fields } })
const where = (items: ReturnType<typeof layout>, bucket: 'today' | 'tomorrow' | 'future') => items.filter((i) => !i.done && (bucket === 'today' ? i.due === 0 : bucket === 'tomorrow' ? i.due === 1 : i.due >= 2)).map((i) => i.text)

describe('small helpers', () => {
  it('counts whole days between London dates', () => {
    expect(daysUntil(WED, '2026-11-19')).toBe(1)
    expect(daysUntil(WED, WED)).toBe(0)
    expect(daysUntil(WED, '2026-11-16')).toBe(-2)
    expect(daysUntil('2026-10-30', '2026-11-02')).toBe(3)
  })
  it('names things in one or two words', () => {
    expect(shorten('Send the safety summary to Dad')).toBe('Safety summary')
    expect(shorten('Pick up the costume')).toBe('Pick costume')
    expect(shorten('Call the dentist')).toBe('Call dentist')
  })
  it('colours by topic, falling back to the area', () => {
    expect(reefFor('Pick up the costume', {})).toBe('School')
    expect(reefFor('Defrost the soup', {})).toBe('Meals')
    expect(reefFor('Renew passports', { topics: ['bali trip'] })).toBe('Bali trip')
    expect(reefFor('Reply to the supplier', { area: 'work' })).toBe('Work')
    expect(reefFor('Call the dentist', { area: 'personal' })).toBe('Home')
    expect(reefFor('Clean the house', { area: 'personal' })).toBe('Home')
    expect(reefFor('Something odd', { area: 'personal' })).toBe('Loose')
  })
  it("gives today's date in London", () => {
    expect(londonToday(new Date('2026-11-18T23:30:00Z'))).toBe('2026-11-18')
    expect(londonToday(new Date('2026-06-18T23:30:00Z'))).toBe('2026-06-19')
  })
})

describe('toItem', () => {
  it('ignores notes that are not things to do', () => {
    expect(toItem({ path: 'ideas/x.md', kind: 'idea', title: 'x', updated_at: '2026-11-01T00:00:00Z', fields: {} }, WED)).toBeNull()
  })
  it('reads the date from due, or from an event start', () => {
    expect(toItem(task('Fake', { due: '2026-11-20' }), WED)?.days).toBe(2)
    expect(toItem(task('Fake concert', { start: '2026-11-21T19:30' }, 'event'), WED)?.days).toBe(3)
    expect(toItem(task('Fake'), WED)).toMatchObject({ days: null, undated: true })
  })
  it('treats done and dropped as done, and maps who and importance', () => {
    expect(toItem(task('Fake', { status: 'done', completed_at: '2026-11-18T08:00:00Z' }), WED)).toMatchObject({ done: true, doneAt: Date.parse('2026-11-18T08:00:00Z') })
    expect(toItem(task('Fake', { status: 'dropped' }), WED)?.done).toBe(true)
    expect(toItem(task('Fake', { people: ['the kids'], importance: 'high' }), WED)).toMatchObject({ who: 'Kids', urgent: true })
  })
})

describe('the balance of work and personal', () => {
  it('aims for seven work and three personal on a weekday, and flips at the weekend', () => {
    expect(quota(WED)).toEqual({ work: 7, personal: 3 })
    expect(quota(SAT)).toEqual({ work: 3, personal: 7 })
    expect(quota('2026-11-22')).toEqual({ work: 3, personal: 7 })
  })
})

describe('layout', () => {
  it('puts what is due today and overdue in Today, tomorrow in Tomorrow, and the rest later', () => {
    const items = layout([task('Due today', { due: WED }), task('Overdue', { due: '2026-11-16' }), task('Due tomorrow', { due: '2026-11-19' }), task('Due in a fortnight', { due: '2026-12-02' })], WED)
    expect(where(items, 'today').sort()).toEqual(['Due today', 'Overdue'])
    expect(where(items, 'tomorrow')).toEqual(['Due tomorrow'])
    expect(where(items, 'future')).toEqual(['Due in a fortnight'])
  })

  it('always shows what is due today, even past the usual quota', () => {
    const lots = Array.from({ length: 5 }, (_, k) => task(`Personal ${k}`, { due: WED, area: 'personal' }))
    expect(where(layout(lots, WED), 'today')).toHaveLength(5)
  })

  it('fills the rest of the day with undated tasks, mostly work on a weekday', () => {
    const work = Array.from({ length: 9 }, (_, k) => task(`Work ${k}`, { area: 'work' }))
    const home = Array.from({ length: 9 }, (_, k) => task(`Home ${k}`, { area: 'personal' }))
    const today = where(layout([...work, ...home], WED), 'today')
    expect(today).toHaveLength(10)
    expect(today.filter((t) => t.startsWith('Work'))).toHaveLength(7)
    expect(today.filter((t) => t.startsWith('Home'))).toHaveLength(3)
    const weekend = where(layout([...work, ...home], SAT), 'today')
    expect(weekend.filter((t) => t.startsWith('Work'))).toHaveLength(3)
    expect(weekend.filter((t) => t.startsWith('Home'))).toHaveLength(7)
  })

  it('lets importance beat the balance when choosing fillers', () => {
    const work = Array.from({ length: 8 }, (_, k) => task(`Work ${k}`, { area: 'work' }))
    const costume = task('Costume for the school event', { area: 'personal', importance: 'high' })
    const home = Array.from({ length: 5 }, (_, k) => task(`Home ${k}`, { area: 'personal' }))
    expect(where(layout([...work, ...home, costume], WED), 'today')).toContain('Costume for the school event')
  })

  it('keeps far-off dated tasks out of Today, however empty the day is', () => {
    const items = layout([task('Pay the deposit', { due: '2026-12-03' }), task('Book flights', { due: '2027-01-20' })], WED)
    expect(where(items, 'today')).toEqual([])
    expect(where(items, 'future').sort()).toEqual(['Book flights', 'Pay the deposit'])
  })

  it('leaves done tasks done, and never places them as open', () => {
    const items = layout([task('Finished', { status: 'done', due: WED, completed_at: '2026-11-18T08:00:00Z' })], WED)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ done: true })
    expect(where(items, 'today')).toEqual([])
  })

  it('never uses an event to fill a day before it happens', () => {
    const items = layout([task('Fake school concert', { start: '2026-11-21T19:30' }, 'event')], WED)
    expect(where(items, 'today')).toEqual([])
    expect(where(items, 'future')).toEqual(['Fake school concert'])
  })

  it('treats events by their start date', () => {
    const items = layout([task('Fake school concert', { start: '2026-11-19T19:30' }, 'event')], WED)
    expect(where(items, 'tomorrow')).toEqual(['Fake school concert'])
  })
})
