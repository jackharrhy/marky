import * as path from 'node:path'

import { serve } from 'remix/node-serve'

import { ContentStore } from './app/data/content-store.ts'
import { attachSockets } from './app/middleware/sockets.ts'
import { router } from './app/router.ts'

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 44100

const contentDir = path.resolve(
  process.env.MARKY_CONTENT_DIR ?? path.join(process.cwd(), 'content'),
)
const store = new ContentStore({ dir: contentDir })
await store.ensureDir()

const server = serve(
  async (request) => {
    try {
      return await router.fetch(request)
    } catch (error) {
      console.error(error)
      return new Response('Internal Server Error', { status: 500 })
    }
  },
  {
    port,
  },
)

attachSockets(server.app, { store })

await server.ready
console.log(`marky is running on http://localhost:${server.port}`)
console.log(`marky: serving content from ${contentDir}`)

let shuttingDown = false

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  server.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
