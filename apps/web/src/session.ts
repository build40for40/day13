// The web list and voice session share the WorkOS sign-in for this tab.
const key = 'dumpling.workos'
export const sessionChanges = new EventTarget()

let accessToken = ''
try {
  accessToken = sessionStorage.getItem(key) ?? ''
} catch {
  // The session can still be held in memory when browser storage is blocked.
}

export function getAccessToken(): string {
  return accessToken
}

export function setAccessToken(token: string): void {
  if (token === accessToken) return
  accessToken = token
  try {
    if (token) sessionStorage.setItem(key, token)
    else sessionStorage.removeItem(key)
  } catch {
    // In-memory sign-in remains available until reload.
  }
  sessionChanges.dispatchEvent(new Event('change'))
}
