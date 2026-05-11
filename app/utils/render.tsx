import type { RemixNode } from 'remix/ui'
import { renderToStream } from 'remix/ui/server'

import type { createRouter } from '../router.ts'

type Router = ReturnType<typeof createRouter>

// The render helper resolves `<Frame>` children by issuing internal
// `router.fetch(...)` requests. To avoid building a second router (which
// would duplicate config and, in discord mode, fail without session deps),
// `server.ts` and any test harness register the real router here at boot.
let activeRouter: Router | null = null

export function setRenderRouter(router: Router): void {
  activeRouter = router
}

export function render(node: RemixNode, request: Request, init?: ResponseInit) {
  if (!activeRouter) {
    throw new Error('render: no router registered. Call setRenderRouter() at boot.')
  }
  const router = activeRouter
  let stream = renderToStream(node, {
    frameSrc: request.url,
    async resolveFrame(src, target) {
      let headers = new Headers({ accept: 'text/html' })
      let cookie = request.headers.get('cookie')
      if (cookie) headers.set('cookie', cookie)
      if (target) headers.set('x-remix-target', target)

      let response = await router.fetch(new Request(new URL(src, request.url), { headers }))
      return response.body ?? response.text()
    },
  })

  let headers = new Headers(init?.headers)
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'text/html; charset=utf-8')
  }

  return new Response(stream, { ...init, headers })
}
