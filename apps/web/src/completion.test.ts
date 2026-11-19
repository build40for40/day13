import { describe, expect, it } from 'vitest'
import { completionMatches } from './completion'
const tasks = [
  { short: 'Safety summary', text: 'Send the safety summary to Dad', done: false },
  { short: 'Supplier reply', text: 'Reply to the equipment supplier', done: false },
  { short: 'Supplier invoice', text: 'Pay the supplier invoice', done: false },
]
describe('completion statements', () => {
  it.each(['Safety summary is done', "I’ve finished the safety summary", 'Mark safety summary as complete', 'I sent the safety summary to Dad'])('matches %s', text => {
    expect(completionMatches(text, tasks)).toEqual([tasks[0]])
  })
  it.each(['The safety summary is not done', "I haven't finished the safety summary", 'Is the safety summary done?', 'I need to get the safety summary done', 'When the safety summary is done, call Dad', 'Mark safety summary as not done', "I'll mark safety summary done tomorrow", 'Send safety summary today'])('leaves %s untouched', text => {
    expect(completionMatches(text, tasks)).toBeNull()
  })
  it('does not guess an unnamed task', () => expect(completionMatches('Done', tasks)).toEqual([]))
  it('does not guess from a shared word', () => expect(completionMatches('Supplier is done', tasks)).toEqual([]))
  it('returns ambiguous matches for clarification', () => expect(completionMatches('Safety summary and supplier reply are done', tasks)).toHaveLength(2))
})
