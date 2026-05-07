import { createRouter } from 'remix/fetch-router'

import { assets } from './assets.ts'
import { home } from './controllers/home.tsx'
import { routes } from './routes.ts'

export const router = createRouter()

router.get(routes.assets, async ({ request }) => {
  const response = await assets.fetch(request)
  return response ?? new Response('Not Found', { status: 404 })
})

router.map(routes.home, home)
