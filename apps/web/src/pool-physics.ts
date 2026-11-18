export type Body = { x: number; y: number; vx: number; vy: number; w: number; h: number; home?: { x: number; y: number } }

// A held dumpling has infinite mass: its neighbours yield and gently pass on the nudge.
export function separateDumplings<T extends Body>(bodies: T[], held: T | null, width: number, height: number, remember: boolean) {
  for (let pass = 0; pass < 3; pass++) {
    for (let a = 0; a < bodies.length; a++) for (let b = a + 1; b < bodies.length; b++) {
      const A = bodies[a]!, B = bodies[b]!
      const dx = B.x - A.x, dy = B.y - A.y
      const rx = (A.w + B.w) / 2 + 5, ry = (A.h + B.h) / 2 + 3
      const distance = Math.hypot(dx / rx, dy / ry)
      if (distance >= 1) continue
      const nx = distance > .001 ? dx / rx / distance : (a % 2 ? -1 : 1)
      const ny = distance > .001 ? dy / ry / distance : 0
      const pushX = nx * rx * (1 - distance) * .55, pushY = ny * ry * (1 - distance) * .55
      const weightA = A === held ? 0 : B === held ? 1 : .5
      const weightB = B === held ? 0 : A === held ? 1 : .5
      for (const [body, weight, sign] of [[A, weightA, -1], [B, weightB, 1]] as const) {
        body.x += pushX * weight * sign; body.y += pushY * weight * sign
        body.vx += pushX * weight * sign * .08; body.vy += pushY * weight * sign * .08
        if (remember && weight) body.home = { x: body.x / width, y: body.y / height }
      }
    }
    for (const body of bodies) {
      const left = Math.min(body.w / 2 + 4, width / 2), right = width - left
      const x = Math.max(left, Math.min(right, body.x)), y = Math.max(18, Math.min(height - 30, body.y))
      if (x !== body.x) body.vx *= -.25
      if (y !== body.y) body.vy *= -.25
      body.x = x; body.y = y
    }
  }
}
