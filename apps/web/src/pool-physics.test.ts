import { describe, expect, it } from 'vitest'
import { separateDumplings, type Body } from './pool-physics'
const body = (x: number, y = 75): Body => ({ x, y, vx: 0, vy: 0, w: 50, h: 30 })
describe('soft dumpling collisions', () => {
  it('keeps the held dumpling in place and nudges its neighbour', () => {
    const held = body(100), neighbour = body(125)
    separateDumplings([held, neighbour], held, 400, 180, true)
    expect(held.x).toBe(100)
    expect(neighbour.x).toBeGreaterThan(125)
    expect(neighbour.vx).toBeGreaterThan(0)
    expect(neighbour.home?.x).toBeCloseTo(neighbour.x / 400)
  })
  it('passes a nudge through a cluster without moving distant dumplings', () => {
    const held = body(100), neighbour = body(130), next = body(172), distant = body(340)
    separateDumplings([held, neighbour, next, distant], held, 400, 180, true)
    expect(next.x).toBeGreaterThan(172)
    expect(distant.x).toBe(340)
  })
  it('separates coincident centres without invalid coordinates', () => {
    const a = body(100), b = body(100)
    separateDumplings([a, b], null, 400, 180, false)
    expect(Number.isFinite(a.x + b.x)).toBe(true)
    expect(a.x).not.toBe(b.x)
  })
  it('keeps displaced dumplings within the pool', () => {
    const a = body(370), b = body(380)
    separateDumplings([a, b], a, 400, 180, true)
    expect(b.x).toBeLessThanOrEqual(371)
    expect(b.y).toBeLessThanOrEqual(150)
  })
})
