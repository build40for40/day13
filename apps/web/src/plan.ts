// Turns the brain's tasks and events into the lists Dumpling shows. Pure functions, so the rules can be tested and changed in one place.
// The brain stores facts (a due date, importance, area). What to show today is worked out here, when the list is read.
import type { Note, NoteFields } from './brain'

/** What the page draws. `due` is whole days from today, placed by `layout`: 0 for Today, 1 for Tomorrow, 2 or more for Future. */
export type Item = {
  path: string
  reef: string
  short: string
  text: string
  due: number
  urgent: boolean
  who?: string
  area: 'work' | 'personal'
  /** The brain has no date for this one. */
  undated: boolean
  done: boolean
  doneAt?: number
  updated: number
}

const REEFS: [string, RegExp][] = [
  ['Meals', /pasta|dinner|meal|menu|recipe|rice|cook|lunch|snack|soup|cake|groceries|shopping/i],
  ['School', /costume|school|teacher|permission|museum|homework|concert/i],
  ['Gifts', /gift|birthday|present|toy|puzzle/i],
  ['Bali trip', /bali|villa|flight|passport|hotel|visa|ubud|holiday|trip/i],
]

/** Which colour an item gets: by what it's about, falling back to its area. */
export function reefFor(title: string, fields: NoteFields): string {
  const text = `${title} ${(fields.topics ?? []).join(' ')}`
  for (const [name, re] of REEFS) if (re.test(text)) return name
  return fields.area === 'work' ? 'Work' : 'Loose'
}

const FILLER = new Set('a an the to for of and or with at on in my me i we need needs have has must should remember dont forget please tomorrow today tonight urgent asap now get do make send is are was be it this that some about before after by up out from really just also then wants want'.split(' '))

/** A one or two word name for a title: the first two words that carry meaning. */
export function shorten(title: string): string {
  const words = title.replace(/[^\w' -]/g, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w.toLowerCase()))
  const out = words.slice(0, 2).join(' ') || title.slice(0, 14)
  return out.charAt(0).toUpperCase() + out.slice(1)
}

/** Whole days from `todayIso` to `dateIso`, both YYYY-MM-DD. Negative when it has passed. */
export function daysUntil(todayIso: string, dateIso: string): number {
  const ms = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
  return Math.round((ms(dateIso) - ms(todayIso)) / 864e5)
}

const isIso = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)

/** One task or event note as an item, or null for notes that aren't a thing to do. `due` is null until `layout` places it. */
export function toItem(note: Note, todayIso: string): (Item & { days: number | null; event: boolean }) | null {
  if (note.kind !== 'task' && note.kind !== 'event') return null
  const f = note.fields ?? {}
  const date = isIso(f.due) ? f.due.slice(0, 10) : note.kind === 'event' && isIso(f.start) ? f.start.slice(0, 10) : null
  const status = f.status ?? 'open'
  return {
    path: note.path,
    reef: reefFor(note.title, f),
    short: shorten(note.title),
    text: note.title,
    due: 0,
    days: date ? daysUntil(todayIso, date) : null,
    event: note.kind === 'event',
    urgent: f.importance === 'high',
    who: f.who === 'kids' ? 'Kids' : f.who === 'grown-ups' ? 'Grown-ups' : undefined,
    area: f.area === 'work' ? 'work' : 'personal',
    undated: date === null,
    done: status !== 'open',
    doneAt: f.completed_at ? Date.parse(f.completed_at) : undefined,
    updated: Date.parse(note.updated_at) || 0,
  }
}

/** How many of each area a day's list aims for: mostly work on weekdays, mostly personal at weekends. It's a starting guess, not a rule. */
export function quota(todayIso: string, total = 10): { work: number; personal: number } {
  const day = new Date(`${todayIso}T12:00:00Z`).getUTCDay()
  const weekend = day === 0 || day === 6
  const major = Math.round(total * 0.7)
  return weekend ? { work: total - major, personal: major } : { work: major, personal: total - major }
}

const weight = (i: { urgent: boolean; days: number | null; updated: number }) => (i.urgent ? 1000 : 0) - (i.days ?? 60) * 10 + i.updated / 1e13

/**
 * Splits open tasks into Today, Tomorrow and Future.
 * Today is everything due today or overdue, always, then filled up to ten with undated or soon-due tasks, aiming for the area balance in `quota`.
 * Importance and a due date come first; the balance only decides what fills the rest. Events never fill a day, since they belong on their own date. Tomorrow is only what's dated tomorrow.
 */
export function layout(notes: Note[], todayIso: string, total = 10): Item[] {
  const all = notes.map((n) => toItem(n, todayIso)).filter((i): i is NonNullable<typeof i> => i !== null)
  const open = all.filter((i) => !i.done)
  const today = open.filter((i) => i.days !== null && i.days <= 0)
  const have = { work: today.filter((i) => i.area === 'work').length, personal: today.filter((i) => i.area === 'personal').length }
  const want = quota(todayIso, total)
  const fillers = open.filter((i) => !today.includes(i) && !i.event && (i.days === null || (i.days >= 2 && i.days <= 7))).sort((a, b) => weight(b) - weight(a))
  for (const f of fillers) {
    if (today.length >= total) break
    if (have[f.area] < want[f.area]) {
      today.push(f)
      have[f.area]++
    }
  }
  const placed = new Set(today)
  const out: Item[] = []
  for (const i of all) {
    const { days, event: _event, ...item } = i
    const due = placed.has(i) ? 0 : days === 1 ? 1 : i.done ? 0 : Math.max(2, days ?? 14)
    out.push({ ...item, due })
  }
  return out
}

/** Today's date in London as YYYY-MM-DD, which is how the brain dates things. */
export function londonToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
