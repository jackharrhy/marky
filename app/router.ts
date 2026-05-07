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
  const router = createFetchRouter()

  router.get(routes.assets, async ({ request }) => {
    const response = await assets.fetch(request)
    return response ?? new Response('Not Found', { status: 404 })
  })

  router.map(routes.home, home)

  if (deps.config.auth.mode === 'discord') {
    if (!deps.sessionStorage) {
      throw new Error('createRouter: sessionStorage is required in discord mode')
    }
    const cookie = createCookie('marky.session', {
      secrets: [deps.config.auth.sessionSecret],
      httpOnly: true,
      sameSite: 'Lax',
      // The session-middleware module insists on a signed cookie. `secrets`
      // above takes care of that. We only set `secure: true` when serving
      // over HTTPS so cookies still flow during local http dev/test runs.
      secure: deps.config.auth.baseUrl.startsWith('https://'),
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })
    const middleware = [
      session(cookie, deps.sessionStorage),
      identityMiddleware(),
    ] as const

    const auth = createAuthController({ auth: deps.config.auth })

    // `Router#use` doesn't exist in this version of remix/fetch-router; the
    // controller objects don't expose a top-level `middleware` slot we can
    // attach via `router.map`, so we register each action with its own
    // middleware tuple.
    router.map(routes.auth.signIn, { middleware, ...auth.signIn } as any)
    router.map(routes.auth.callback, { middleware, ...auth.callback } as any)
    router.map(routes.auth.signOut, { middleware, ...auth.signOut } as any)
  }

  return router
}
