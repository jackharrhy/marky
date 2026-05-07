import type { Cookie } from 'remix/cookie'
import { createRouter as createFetchRouter } from 'remix/fetch-router'
import type { SessionStorage } from 'remix/session'
import { session } from 'remix/session-middleware'

import { assets } from './assets.ts'
import type { AppConfig } from './config.ts'
import { createAuthController } from './controllers/auth/controller.tsx'
import { home } from './controllers/home.tsx'
import { identityMiddleware } from './middleware/auth.ts'
import { routes } from './routes.ts'

export interface RouterDeps {
  config: AppConfig
  sessionStorage?: SessionStorage
  sessionCookie?: Cookie
}

export function createRouter(deps: RouterDeps) {
  if (deps.config.auth.mode === 'discord') {
    if (!deps.sessionStorage || !deps.sessionCookie) {
      throw new Error(
        'createRouter: sessionStorage and sessionCookie are required in discord mode',
      )
    }

    // Apply session + identity middleware to every route so the home route
    // can read `Identity` to gate access. The cookie + storage are owned by
    // the caller so the WebSocket upgrade can verify the same signed cookie.
    const router = createFetchRouter({
      middleware: [
        session(deps.sessionCookie, deps.sessionStorage),
        identityMiddleware(),
      ] as any,
    })

    wireCommonRoutes(router)

    const auth = createAuthController({ auth: deps.config.auth })
    router.map(routes.auth.signIn, auth.signIn)
    router.map(routes.auth.callback, auth.callback)
    router.map(routes.auth.signOut, auth.signOut)

    return router
  }

  // Anonymous mode: vanilla router, no session machinery.
  const router = createFetchRouter()
  wireCommonRoutes(router)
  return router
}

function wireCommonRoutes(router: ReturnType<typeof createFetchRouter>) {
  router.get(routes.assets, async ({ request }) => {
    const response = await assets.fetch(request)
    return response ?? new Response('Not Found', { status: 404 })
  })
  router.map(routes.home, home)
}
