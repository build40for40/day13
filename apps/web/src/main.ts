import { createBrain } from './brain'
import { createFakeBrain } from './fake'

// `pnpm fake` runs against the fake brain. Sign-in isn't wired yet, so the real one needs a token from the shared WorkOS app.
export const brain = import.meta.env.MODE === 'fake' ? createFakeBrain() : createBrain({ getToken: () => '' })

document.querySelector<HTMLDivElement>('#app')!.textContent = 'day13'
