import { createRouter as createFetchRouter } from 'remix/fetch-router'
import type { SessionStorage } from 'remix/session'

import { assets } from './assets.ts'
import type { AppConfig } from './config.ts'
import { home } from './controllers/home.tsx'
import { routes } from './routes.ts'

export interface RouterDeps {
  config: AppConfig
  sessionStorage?: SessionStorage
}

export function createRouter(deps: RouterDeps) {
  const router = createFetchRouter()

  router.get(routes.assets, async ({ request }) => {
    const response = await assets.fetch(request)
    return response ?? new Response('Not Found', { status: 404 })
  })

  router.map(routes.home, home)

  // Discord auth routes are wired in Task 4. Anonymous mode never registers
  // them; they 404 through the default handler.
  if (deps.config.auth.mode === 'discord') {
    // Placeholder — Task 4 will replace this block with the auth controller.
  }

  return router
}
