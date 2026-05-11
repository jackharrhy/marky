import { createCookie } from 'remix/cookie'
import { serve } from 'remix/node-serve'
import { createFsSessionStorage } from 'remix/session/fs-storage'

import { loadConfig } from './app/config.ts'
import { ContentStore } from './app/data/content-store.ts'
import { GitStore } from './app/data/git-store.ts'
import { attachSockets } from './app/middleware/sockets.ts'
import { createRouter } from './app/router.ts'
import { setRenderRouter } from './app/utils/render.tsx'

const config = loadConfig()
const store = new ContentStore({ dir: config.contentDir })
await store.ensureDir()

let gitStore: GitStore | undefined
if (config.git) {
  gitStore = new GitStore({
    repoDir: config.git.repoDir,
    authorName: config.git.authorName,
    authorEmail: config.git.authorEmail,
    push: config.git.push,
  })
  await gitStore.assertRepo()
}

// In discord mode, the same `Cookie` + `SessionStorage` instances back both
// the HTTP router (via `session()` middleware) and the WebSocket upgrade
// handler. Sharing them is what lets the WS path verify the signed cookie
// the auth controller planted.
let sessionCookie: ReturnType<typeof createCookie> | undefined
let sessionStorage: ReturnType<typeof createFsSessionStorage> | undefined

if (config.auth.mode === 'discord') {
  sessionCookie = createCookie('marky.session', {
    secrets: [config.auth.sessionSecret],
    httpOnly: true,
    sameSite: 'Lax',
    // Only set `secure: true` when serving over HTTPS so cookies still flow
    // during local http dev/test runs.
    secure: config.auth.baseUrl.startsWith('https://'),
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })
  sessionStorage = createFsSessionStorage('./tmp/sessions')
}

const router = createRouter({ config, sessionStorage, sessionCookie })
setRenderRouter(router)

const server = serve(
  async (request) => {
    try {
      return await router.fetch(request)
    } catch (error) {
      console.error(error)
      return new Response('Internal Server Error', { status: 500 })
    }
  },
  { port: config.port },
)

const room = attachSockets(server.app, {
  store,
  config,
  gitStore,
  sessionStorage,
  sessionCookie,
})

await server.ready
console.log(`marky is running on http://localhost:${server.port}`)
console.log(`marky: serving content from ${config.contentDir}`)

let shuttingDown = false

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await room.dispose()
  } catch (error) {
    console.error('marky: error during room dispose:', error)
  }
  server.close()
  process.exit(0)
}

process.on('SIGINT', () => { shutdown() })
process.on('SIGTERM', () => { shutdown() })
