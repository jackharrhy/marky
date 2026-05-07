import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCookie } from 'remix/cookie'
import { createRouter } from 'remix/fetch-router'
import { createMemorySessionStorage } from 'remix/session/memory-storage'

import { Identity, identityMiddleware, type IdentityValue } from '../app/middleware/auth.ts'

describe('identityMiddleware', () => {
  it('exposes null Identity when no session is present', async () => {
    const router = createRouter({
      middleware: [identityMiddleware()],
    })
    let captured: IdentityValue | null | undefined
    router.get('/probe', ({ get }) => {
      captured = (get as any)(Identity)
      return new Response('ok')
    })

    const response = await router.fetch(new Request('http://localhost/probe'))
    assert.equal(response.status, 200)
    assert.equal(captured, null)
  })

  it('reads identity from a session', async () => {
    const cookie = createCookie('marky.session', { secrets: ['test'] })
    const storage = createMemorySessionStorage()

    // Seed a session manually.
    const seedSession = await storage.read(null)
    seedSession.set('identity', { discordId: '42', name: 'Jack', color: '#ff0000' })
    const sessionId = await storage.save(seedSession)
    assert.ok(sessionId)
    // `storage.save` returns the raw session ID; we still need the cookie to
    // sign + serialize it into a valid `Cookie` header.
    const cookieHeader = await cookie.serialize(sessionId)

    const { session } = await import('remix/session-middleware')
    const router = createRouter({
      middleware: [session(cookie, storage), identityMiddleware()],
    })
    let captured: IdentityValue | null | undefined
    router.get('/probe', ({ get }) => {
      captured = (get as any)(Identity)
      return new Response('ok')
    })

    const response = await router.fetch(
      new Request('http://localhost/probe', { headers: { cookie: cookieHeader } }),
    )
    assert.equal(response.status, 200)
    assert.deepEqual(captured, { discordId: '42', name: 'Jack', color: '#ff0000' })
  })
})
