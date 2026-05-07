import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { router } from '../app/router.ts'
import { routes } from '../app/routes.ts'

describe('routes', () => {
  it('home page returns 200 HTML', async () => {
    const response = await router.fetch(new Request('http://localhost' + routes.home.href()))
    assert.equal(response.status, 200)
    const contentType = response.headers.get('content-type') ?? ''
    assert.match(contentType, /text\/html/)
    const body = await response.text()
    assert.match(body, /marky/)
  })

  it('home page mounts the editor client entry', async () => {
    const response = await router.fetch(new Request('http://localhost' + routes.home.href()))
    const body = await response.text()
    assert.match(body, /editor-app\.tsx/)
    // Hydration props payload is emitted by the runtime for client entries.
    assert.match(body, /rmx-data/)
  })

  it('asset route compiles a TypeScript module', async () => {
    const url = 'http://localhost' + routes.assets.href({ path: 'app/shared/constants.ts' })
    const response = await router.fetch(new Request(url))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /javascript/)
    const body = await response.text()
    assert.match(body, /PROSEMIRROR_FRAGMENT_NAME/)
  })

  it('asset route 404s on a missing file', async () => {
    const url = 'http://localhost' + routes.assets.href({ path: 'app/missing-file.ts' })
    const response = await router.fetch(new Request(url))
    assert.equal(response.status, 404)
  })

  it('asset route denies server-only modules', async () => {
    const url = 'http://localhost' + routes.assets.href({ path: 'app/middleware/sockets.ts' })
    const response = await router.fetch(new Request(url))
    assert.notEqual(response.status, 200)
  })

  it('asset route denies app/data/discord.ts', async () => {
    const url = 'http://localhost' + routes.assets.href({ path: 'app/data/discord.ts' })
    const response = await router.fetch(new Request(url))
    assert.notEqual(response.status, 200)
  })

  it('asset route denies app/config.ts', async () => {
    const url = 'http://localhost' + routes.assets.href({ path: 'app/config.ts' })
    const response = await router.fetch(new Request(url))
    // app/config.ts is at the app root; allow rules don't match it, so the
    // asset server should not serve it.
    assert.notEqual(response.status, 200)
  })
})
