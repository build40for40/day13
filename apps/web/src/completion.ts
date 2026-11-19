type Task = { short: string; text: string; done: boolean }
const words = (text: string) => text.toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) ?? []
const stop = new Set('a an the i ive have has had is are was were my our your it this that task tasks please mark as now already just done finished complete completed sent replied called paid booked ordered packed signed off tick checked and to for of with'.split(' '))
const keyWords = (text: string) => words(text).filter(w => !stop.has(w))

// Only affirmative completion statements, with an unambiguous task name.
// Return null for ordinary input, and [] for a completion we cannot safely match.
export function completionMatches<T extends Task>(text: string, tasks: T[]): T[] | null {
  const normalized = words(text).join(' ')
  if (!/\b(done|finished|complete|completed|sent|replied|called|paid|booked|ordered|packed|signed)\b|\b(tick|check)(ed)? off\b/.test(normalized)) return null
  if (/\?|\b(not|no|never|havent|hasnt|isnt|arent|wasnt|werent|dont|didnt|cant|cannot|couldnt|wont|isn|haven|hasn|didn|don|can|could|should|would|will|need|needs|must|when|whether|if|before|after|once|until|tomorrow)\b/.test(normalized) || /\?/.test(text)) return null
  const said = keyWords(text)
  if (!said.length) return []
  const named = tasks.filter(task => {
    const name = keyWords(task.short)
    return name.length > 0 && name.every(w => said.includes(w))
  })
  if (named.length) return named
  return tasks.filter(task => {
    const detail = keyWords(task.text)
    return said.length >= 2 && said.every(w => detail.includes(w))
  })
}
