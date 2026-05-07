import { serve } from 'remix/node-serve'

import { loadConfig } from './app/config.ts'
import { ContentStore } from './app/data/content-store.ts'
import { attachSockets } from './app/middleware/sockets.ts'
import { createRouter } from './app/router.ts'

const config = loadConfig()
const store = new ContentStore({ dir: config.contentDir })
await store.ensureDir()

const router = createRouter({ config })

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

attachSockets(server.app, { store })

await server.ready
console.log(`marky is running on http://localhost:${server.port}`)
console.log(`marky: serving content from ${config.contentDir}`)

let shuttingDown = false

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  server.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
