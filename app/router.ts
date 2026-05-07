import { createCookie } from 'remix/cookie'
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
}

export function createRouter(deps: RouterDeps) {
  if (deps.config.auth.mode === 'discord') {
    if (!deps.sessionStorage) {
      throw new Error('createRouter: sessionStorage is required in discord mode')
    }
    const cookie = createCookie('marky.session', {
      secrets: [deps.config.auth.sessionSecret],
      httpOnly: true,
      sameSite: 'Lax',
      // Only set `secure: true` when serving over HTTPS so cookies still flow
      // during local http dev/test runs.
      secure: deps.config.auth.baseUrl.startsWith('https://'),
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })

    // Apply session + identity middleware to every route so the home route
    // can read `Identity` to gate access.
    const router = createFetchRouter({
      middleware: [session(cookie, deps.sessionStorage), identityMiddleware()] as any,
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
