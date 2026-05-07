# Auth OAuth + WS identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Discord OAuth flow into the router, gate `/` behind a session in discord mode, surface the identity into `EditorApp`, and stamp authoritative awareness on the WebSocket so peers can't impersonate each other. Anonymous mode behavior stays unchanged.

**Architecture:** A new auth controller owns `/auth/*`. A new `app/middleware/auth.ts` module wires session middleware (discord mode) and exposes a typed `Identity` context key. `app/router.ts` and `server.ts` switch on `loadConfig().auth.mode`. `SocketRoom` gains an optional per-peer identity that overwrites the `user` field of awareness updates via `modifyAwarenessUpdate`.

**Tech Stack:** Remix 3 (`remix/session-middleware`, `remix/session/fs-storage`, `remix/cookie`, `remix/fetch-router`), uWebSockets.js (existing), `y-protocols/awareness` (`modifyAwarenessUpdate`).

**Reference:** `docs/superpowers/specs/2026-05-07-auth-modes-design.md` — sections "Auth middleware", "Routes", "Auth controller", "Home controller gating", "EditorApp props", "WebSocket identity", "Server boot order", "NotInGuildPage", "Failure modes".

**Prerequisite:** plan 1 is merged. `app/config.ts` and `app/data/discord.ts` exist and are tested.

---

## File Structure

- Create: `app/middleware/auth.ts` — `Identity` interface, `createSessionStorage`, `loadAuth` middleware
- Create: `app/controllers/auth/controller.tsx` — `/auth/sign-in|callback|sign-out` handlers
- Create: `app/controllers/auth/not-in-guild-page.tsx` — friendly 404-style page
- Create: `test/auth.test.ts` — controller integration tests using `router.fetch`
- Modify: `app/routes.ts` — add `auth.signIn`, `auth.callback`, `auth.signOut`
- Modify: `app/router.ts` — accept config + sessionStorage, register auth routes in discord mode
- Modify: `app/controllers/home.tsx` — gate `/` in discord mode, pass `authMode` to EditorApp
- Modify: `app/ui/editor/editor-app.tsx` — accept `authMode` prop, sign-out button, skip `getUser()` in discord mode
- Modify: `app/middleware/sockets.ts` — `SocketRoom.addPeer(peer, identity?)`, awareness rewriting; `attachSockets` accepts `authConfig` + `sessionStorage`
- Modify: `server.ts` — wire config, session storage, pass into router and sockets
- Modify: `test/socket-room.test.ts` — add identity-overwrite test
- Modify: `test/routes.test.ts` — add discord-mode home gating test (needs router factory)

We need a way to construct the router with a different config in tests. Plan: `app/router.ts` exports both the default `router` (for production import sites that already exist) and a new `createRouter(config, sessionStorage?)` factory used by tests and by `server.ts`. The default export becomes a thin wrapper that calls `createRouter(loadConfig())`.

---

### Task 1: Routes + skeleton router factory

**Goal:** Add `/auth/*` URLs to the contract and refactor `app/router.ts` to a factory function. No behavior change yet — the new routes 404 because nothing's mapped.

**Files:**
- Modify: `app/routes.ts`
- Modify: `app/router.ts`

- [ ] **Step 1: Update `app/routes.ts`**

```ts
import { get, post, route } from 'remix/fetch-router/routes'

export const routes = route({
  assets: get('/assets/*path'),
  home: '/',
  auth: route('auth', {
    signIn: get('sign-in'),
    callback: get('callback'),
    signOut: post('sign-out'),
  }),
})
```

- [ ] **Step 2: Refactor `app/router.ts` to a factory**

Replace the file contents with:

```ts
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

  // Discord auth routes are wired in Task 4. Anonymous mode never
  // registers them; they 404 through the default handler.
  if (deps.config.auth.mode === 'discord') {
    // Placeholder — Task 4 will replace this block with the auth controller.
  }

  return router
}
```

There is intentionally no top-level `router` export anymore. Existing `app/utils/render.tsx` imports `router` from `./router.ts`; we have to update that too in Task 2. Don't run tests yet — they will be broken until Task 2 lands.

- [ ] **Step 3: Commit**

Stage everything we just touched. Tests will fail at this commit — that's expected, the next task fixes it.

```sh
git add app/routes.ts app/router.ts
git commit -m "router: extract createRouter factory and add /auth/* routes"
```

---

### Task 2: Repair the render helper and existing call sites for the factory

**Goal:** `app/utils/render.tsx` and `server.ts` were importing the old top-level `router`. They have to call `createRouter` now.

**Files:**
- Modify: `app/utils/render.tsx`
- Modify: `server.ts`

- [ ] **Step 1: Update `app/utils/render.tsx`**

The render helper uses `router.fetch` to resolve frames. Build a router lazily from config so the factory only runs when needed:

```tsx
import type { RemixNode } from 'remix/ui'
import { renderToStream } from 'remix/ui/server'

import { loadConfig } from '../config.ts'
import { createRouter } from '../router.ts'

// One process-wide router for frame resolution. Built lazily so the test
// harness can construct its own router with overrides without colliding.
let frameRouter: ReturnType<typeof createRouter> | null = null
function getFrameRouter() {
  if (!frameRouter) frameRouter = createRouter({ config: loadConfig() })
  return frameRouter
}

export function render(node: RemixNode, request: Request, init?: ResponseInit) {
  const router = getFrameRouter()
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
```

- [ ] **Step 2: Update `server.ts` to construct the router from config**

```ts
import * as path from 'node:path'

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
```

- [ ] **Step 3: Update `test/routes.test.ts` to use the factory**

The tests previously imported a top-level `router`. Replace those imports.

Find `import { router } from '../app/router.ts'` and change it to:

```ts
import { createRouter } from '../app/router.ts'
import { loadConfig } from '../app/config.ts'

const router = createRouter({ config: loadConfig({}) })
```

The empty `{}` env keeps anonymous mode and avoids reading process.env during tests.

- [ ] **Step 4: Run typecheck and tests**

```sh
npm run typecheck
npm test
```

Expected: 72/72 pass. If any test imports `router` directly and fails, fix that file the same way Step 3 fixed routes.test.ts.

- [ ] **Step 5: Commit**

```sh
git add app/utils/render.tsx server.ts test/routes.test.ts
git commit -m "router: thread config through render helper, server, and tests"
```

---

### Task 3: Auth middleware (session storage + Identity context)

**Goal:** Provide a typed `Identity` value to controllers in discord mode. Anonymous mode is a no-op.

**Files:**
- Create: `app/middleware/auth.ts`
- Create: `test/auth-middleware.test.ts`

- [ ] **Step 1: Write the failing test `test/auth-middleware.test.ts`**

```ts
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCookie } from 'remix/cookie'
import { createRouter } from 'remix/fetch-router'
import { createMemorySessionStorage } from 'remix/session/memory-storage'

import { Identity, identityMiddleware, type IdentityValue } from '../app/middleware/auth.ts'

describe('identityMiddleware', () => {
  it('exposes null Identity when no session is present', async () => {
    const router = createRouter({
      middleware: [identityMiddleware()],
    })
    let captured: IdentityValue | null | undefined
    router.get('/probe', ({ get }) => {
      captured = (get as any)(Identity)
      return new Response('ok')
    })

    const response = await router.fetch(new Request('http://localhost/probe'))
    assert.equal(response.status, 200)
    assert.equal(captured, null)
  })

  it('reads identity from a session', async () => {
    const cookie = createCookie('marky.session', { secrets: ['test'] })
    const storage = createMemorySessionStorage()

    // Seed a session manually.
    const seedSession = await storage.read(null)
    seedSession.set('identity', { discordId: '42', name: 'Jack', color: '#ff0000' })
    const setCookie = await storage.save(seedSession)
    assert.ok(setCookie)
    const cookieHeader = setCookie

    const { session } = await import('remix/session-middleware')
    const router = createRouter({
      middleware: [session(cookie, storage), identityMiddleware()],
    })
    let captured: IdentityValue | null | undefined
    router.get('/probe', ({ get }) => {
      captured = (get as any)(Identity)
      return new Response('ok')
    })

    const response = await router.fetch(
      new Request('http://localhost/probe', { headers: { cookie: cookieHeader } }),
    )
    assert.equal(response.status, 200)
    assert.deepEqual(captured, { discordId: '42', name: 'Jack', color: '#ff0000' })
  })
})
```

Run: expected to fail because `app/middleware/auth.ts` doesn't exist.

```sh
npx tsx --test --test-force-exit test/auth-middleware.test.ts
```

- [ ] **Step 2: Implement `app/middleware/auth.ts`**

```ts
import type { Middleware } from 'remix/fetch-router'
import { Session } from 'remix/session'

// Identity carried in the session cookie when a user has signed in via Discord.
// Persisted as the `identity` field of the session payload.
export interface IdentityValue {
  discordId: string
  name: string
  color: string
}

// Class used as a typed context key. `context.get(Identity)` returns
// `IdentityValue | null` (set by `identityMiddleware`).
export class Identity {
  private constructor() {}
  // Phantom property so TS infers the right value type for context.get.
  declare readonly __value: IdentityValue | null
}

export function identityMiddleware(): Middleware {
  return (async (context, next) => {
    let value: IdentityValue | null = null
    try {
      const session = context.get(Session)
      const stored = session.get('identity') as IdentityValue | undefined
      if (stored) value = stored
    } catch {
      // Session not in stack (anonymous mode); leave value null.
    }
    // The middleware-context generic system is too rigid for ad-hoc keys.
    // The contract that matters is the handler-side `context.get(Identity)`.
    ;(context as any).set(Identity, value)
    return next()
  }) as Middleware
}
```

If you hit type-system friction during this task: it is OK to use `as Middleware` and `as any` casts to satisfy the framework's middleware generics. The handler-side type (`context.get(Identity)`) is what matters.

- [ ] **Step 3: Run the auth-middleware test, expect pass**

```sh
npx tsx --test --test-force-exit test/auth-middleware.test.ts
```

Expected: 2 pass.

- [ ] **Step 4: Run full suite + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 74 pass.

- [ ] **Step 5: Commit**

```sh
git add app/middleware/auth.ts test/auth-middleware.test.ts
git commit -m "middleware: add identity context key reading from session"
```

---

### Task 4: Auth controller — sign-in, callback, sign-out

**Goal:** Implement `/auth/sign-in`, `/auth/callback`, `/auth/sign-out` handlers in `app/controllers/auth/`.

**Files:**
- Create: `app/controllers/auth/controller.tsx`
- Create: `app/controllers/auth/not-in-guild-page.tsx`
- Create: `test/auth.test.ts`
- Modify: `app/router.ts` (wire the controller in discord mode)

- [ ] **Step 1: Write `app/controllers/auth/not-in-guild-page.tsx`**

```tsx
import { css } from 'remix/ui'

import { routes } from '../../routes.ts'

const containerStyle = css({
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--bg, #fffcf0)',
  fontFamily:
    "'Source Code Pro', 'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
  padding: '24px',
})

const cardStyle = css({
  maxWidth: '480px',
  padding: '32px',
  border: '1px solid #cecdc3',
  borderRadius: '8px',
  background: '#f2f0e5',
  textAlign: 'center',
})

const linkStyle = css({
  color: '#205ea6',
  textDecoration: 'underline',
})

export function NotInGuildPage() {
  return () => (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>marky — access required</title>
      </head>
      <body mix={containerStyle}>
        <main mix={cardStyle}>
          <h1>You're not in the right Discord server.</h1>
          <p>
            marky is gated to members of a specific Discord server. Sign in
            with a Discord account that's a member there to continue.
          </p>
          <p>
            <a mix={linkStyle} href={routes.auth.signIn.href()}>
              Try signing in again
            </a>
          </p>
        </main>
      </body>
    </html>
  )
}
```

- [ ] **Step 2: Write `app/controllers/auth/controller.tsx`**

```tsx
import * as crypto from 'node:crypto'

import type { BuildAction, Controller } from 'remix/fetch-router'
import { redirect } from 'remix/response/redirect'
import { Session } from 'remix/session'

import type { DiscordAuthConfig } from '../../config.ts'
import {
  deterministicPaletteColor,
  exchangeCode,
  fetchGuildMember,
  fetchGuildRoles,
  resolveDisplayName,
  resolveRoleColor,
} from '../../data/discord.ts'
import type { IdentityValue } from '../../middleware/auth.ts'
import { routes } from '../../routes.ts'
import { render } from '../../utils/render.tsx'
import { NotInGuildPage } from './not-in-guild-page.tsx'

const STATE_KEY = 'oauth.state'
const IDENTITY_KEY = 'identity'

export interface AuthControllerDeps {
  auth: DiscordAuthConfig
}

export function createAuthController(deps: AuthControllerDeps) {
  const redirectUri = `${deps.auth.baseUrl}/auth/callback`

  const signIn: BuildAction<'GET', typeof routes.auth.signIn> = {
    handler({ get }) {
      const session = get(Session)
      const state = crypto.randomBytes(32).toString('hex')
      session.set(STATE_KEY, state)

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: deps.auth.clientId,
        scope: 'identify guilds.members.read',
        redirect_uri: redirectUri,
        state,
        prompt: 'none',
      })
      return redirect(`https://discord.com/api/oauth2/authorize?${params}`)
    },
  }

  const callback: BuildAction<'GET', typeof routes.auth.callback> = {
    async handler({ get, request }) {
      const session = get(Session)
      const url = new URL(request.url)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const expected = session.get(STATE_KEY) as string | undefined
      session.unset(STATE_KEY)

      if (!code || !state || !expected || state !== expected) {
        return new Response('OAuth state mismatch, please try signing in again.', {
          status: 400,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }

      let exchange
      try {
        exchange = await exchangeCode({
          clientId: deps.auth.clientId,
          clientSecret: deps.auth.clientSecret,
          code,
          redirectUri,
        })
      } catch (error) {
        console.error('marky: token exchange failed', error)
        return new Response('Discord sign-in failed. Please try again.', {
          status: 502,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }

      let member
      try {
        member = await fetchGuildMember({
          accessToken: exchange.accessToken,
          guildId: deps.auth.guildId,
        })
      } catch (error) {
        console.error('marky: guild-member fetch failed', error)
        return new Response('Discord sign-in failed. Please try again.', {
          status: 502,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }

      if (!member) {
        return render(<NotInGuildPage />, request, { status: 403 })
      }

      const name = resolveDisplayName(member)
      let color: string | null = null
      if (deps.auth.botToken) {
        try {
          const roles = await fetchGuildRoles({
            botToken: deps.auth.botToken,
            guildId: deps.auth.guildId,
          })
          color = resolveRoleColor(member.roleIds, roles)
        } catch (error) {
          console.error('marky: roles fetch failed; falling back to palette', error)
        }
      }
      if (!color) color = deterministicPaletteColor(member.user.id)

      const identity: IdentityValue = {
        discordId: member.user.id,
        name,
        color,
      }
      session.set(IDENTITY_KEY, identity)
      session.regenerateId(true)

      return redirect(routes.home.href())
    },
  }

  const signOut: BuildAction<'POST', typeof routes.auth.signOut> = {
    handler({ get }) {
      const session = get(Session)
      session.unset(IDENTITY_KEY)
      session.regenerateId(true)
      return redirect(routes.home.href())
    },
  }

  return {
    actions: { signIn, callback, signOut },
  } satisfies Controller<typeof routes.auth>
}
```

- [ ] **Step 3: Wire the controller in `app/router.ts`**

Replace the placeholder `if (deps.config.auth.mode === 'discord') { ... }` block with:

```ts
if (deps.config.auth.mode === 'discord') {
  const cookie = await import('remix/cookie').then((m) =>
    m.createCookie('marky.session', {
      secrets: [deps.config.auth.mode === 'discord' ? deps.config.auth.sessionSecret : 'unused'],
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.config.auth.baseUrl.startsWith('https://'),
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    }),
  )
  const sessionMod = await import('remix/session-middleware')
  const authMod = await import('./middleware/auth.ts')
  const controllerMod = await import('./controllers/auth/controller.tsx')

  if (!deps.sessionStorage) {
    throw new Error('createRouter: sessionStorage is required in discord mode')
  }

  const middleware = [sessionMod.session(cookie, deps.sessionStorage), authMod.identityMiddleware()]
  const authRouter = createFetchRouter({ middleware })
  const auth = controllerMod.createAuthController({ auth: deps.config.auth })

  authRouter.map(routes.auth.signIn, auth.actions.signIn)
  authRouter.map(routes.auth.callback, auth.actions.callback)
  authRouter.map(routes.auth.signOut, auth.actions.signOut)

  router.use(authRouter)
}
```

If `Router#use` doesn't exist or works differently in `remix/fetch-router`, fall back to mapping each route with the middleware applied per-action:

```ts
router.map(routes.auth.signIn, { middleware, ...auth.actions.signIn })
router.map(routes.auth.callback, { middleware, ...auth.actions.callback })
router.map(routes.auth.signOut, { middleware, ...auth.actions.signOut })
```

The router factory must become async because of the dynamic imports. Update its signature:

```ts
export async function createRouter(deps: RouterDeps) {
  // ...same body but with the await-using block at the end
}
```

Then update `server.ts` and `app/utils/render.tsx` to await `createRouter`. In `render.tsx`:

```ts
let frameRouterPromise: Promise<Awaited<ReturnType<typeof createRouter>>> | null = null
function getFrameRouter() {
  if (!frameRouterPromise) frameRouterPromise = createRouter({ config: loadConfig() })
  return frameRouterPromise
}

export async function render(node: RemixNode, request: Request, init?: ResponseInit) {
  const router = await getFrameRouter()
  // ...
}
```

In `server.ts`:

```ts
const router = await createRouter({ config })
```

In `test/routes.test.ts`:

```ts
const router = await createRouter({ config: loadConfig({}) })
```

The test must use a top-level `await` (allowed in `tsx --test`) or move construction into `before`. Since the existing test imports `routes` and `router` at top level, use a top-level await: change `const router = createRouter(...)` to `const router = await createRouter(...)`.

If the existing routes test file uses `describe`/`it` only, top-level await is fine in the ESM module. Otherwise wrap setup in a `before(async () => { router = await createRouter(...) })` and declare `let router: Awaited<ReturnType<typeof createRouter>>`.

- [ ] **Step 4: Write `test/auth.test.ts`**

```ts
import * as assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { loadConfig } from '../app/config.ts'
import { _resetRolesCacheForTests } from '../app/data/discord.ts'
import { createRouter } from '../app/router.ts'

const VALID_DISCORD_ENV = {
  MARKY_AUTH: 'discord',
  DISCORD_CLIENT_ID: 'cid',
  DISCORD_CLIENT_SECRET: 'csecret',
  DISCORD_GUILD_ID: 'gid',
  MARKY_BASE_URL: 'http://localhost',
  SESSION_SECRET: 'test-secret',
}

describe('auth controller', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    _resetRolesCacheForTests()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('GET /auth/sign-in redirects to Discord with the right params and stores state', async () => {
    const { createMemorySessionStorage } = await import('remix/session/memory-storage')
    const sessionStorage = createMemorySessionStorage()
    const router = await createRouter({ config: loadConfig(VALID_DISCORD_ENV), sessionStorage })

    const response = await router.fetch(new Request('http://localhost/auth/sign-in'))
    assert.equal(response.status, 302)
    const location = response.headers.get('location') ?? ''
    assert.match(location, /^https:\/\/discord\.com\/api\/oauth2\/authorize\?/)
    assert.match(location, /client_id=cid/)
    assert.match(location, /scope=identify\+guilds\.members\.read/)
    assert.match(
      location,
      /redirect_uri=http%3A%2F%2Flocalhost%2Fauth%2Fcallback/,
    )
    assert.match(location, /state=[0-9a-f]{64}/)
    // The session cookie should be set so callback can verify state.
    const setCookie = response.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /marky\.session=/)
  })

  it('GET /auth/callback with mismatched state returns 400', async () => {
    const { createMemorySessionStorage } = await import('remix/session/memory-storage')
    const sessionStorage = createMemorySessionStorage()
    const router = await createRouter({ config: loadConfig(VALID_DISCORD_ENV), sessionStorage })

    const response = await router.fetch(
      new Request('http://localhost/auth/callback?code=abc&state=wrong'),
    )
    assert.equal(response.status, 400)
  })

  it('GET /auth/callback with not-in-guild renders the gate page (403)', async () => {
    // Stub fetch: token exchange ok, member returns 404.
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString()
      if (url.endsWith('/oauth2/token')) {
        return new Response(
          JSON.stringify({ access_token: 't', token_type: 'Bearer', expires_in: 100 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/users/@me/guilds/')) {
        return new Response('', { status: 404 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }

    const { createMemorySessionStorage } = await import('remix/session/memory-storage')
    const sessionStorage = createMemorySessionStorage()
    const router = await createRouter({ config: loadConfig(VALID_DISCORD_ENV), sessionStorage })

    // 1. sign-in to plant the state cookie
    const start = await router.fetch(new Request('http://localhost/auth/sign-in'))
    const cookieHeader = start.headers.get('set-cookie')!.split(';')[0]
    const stateMatch = start.headers.get('location')!.match(/state=([0-9a-f]{64})/)!
    const state = stateMatch[1]

    // 2. callback with valid state, member returns 404
    const response = await router.fetch(
      new Request(`http://localhost/auth/callback?code=abc&state=${state}`, {
        headers: { cookie: cookieHeader },
      }),
    )
    assert.equal(response.status, 403)
    const body = await response.text()
    assert.match(body, /not in the right Discord server/i)
  })

  it('GET /auth/callback happy path creates a session and redirects to /', async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString()
      if (url.endsWith('/oauth2/token')) {
        return new Response(
          JSON.stringify({ access_token: 't', token_type: 'Bearer', expires_in: 100 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/users/@me/guilds/')) {
        return new Response(
          JSON.stringify({
            nick: 'Jacky',
            roles: [],
            user: { id: '1234', username: 'jack', global_name: null },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    }

    const { createMemorySessionStorage } = await import('remix/session/memory-storage')
    const sessionStorage = createMemorySessionStorage()
    const router = await createRouter({ config: loadConfig(VALID_DISCORD_ENV), sessionStorage })

    const start = await router.fetch(new Request('http://localhost/auth/sign-in'))
    const cookieHeader = start.headers.get('set-cookie')!.split(';')[0]
    const state = start.headers.get('location')!.match(/state=([0-9a-f]{64})/)![1]

    const response = await router.fetch(
      new Request(`http://localhost/auth/callback?code=abc&state=${state}`, {
        headers: { cookie: cookieHeader },
      }),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/')
    // A new session cookie should be set after regenerateId.
    const newCookie = response.headers.get('set-cookie') ?? ''
    assert.match(newCookie, /marky\.session=/)
  })

  it('POST /auth/sign-out unsets identity and redirects to /', async () => {
    const { createMemorySessionStorage } = await import('remix/session/memory-storage')
    const sessionStorage = createMemorySessionStorage()
    const router = await createRouter({ config: loadConfig(VALID_DISCORD_ENV), sessionStorage })

    // Seed a session with an identity directly.
    const seed = await sessionStorage.read(null)
    seed.set('identity', { discordId: '1', name: 'a', color: '#000000' })
    const setCookie = await sessionStorage.save(seed)
    assert.ok(setCookie)

    const response = await router.fetch(
      new Request('http://localhost/auth/sign-out', {
        method: 'POST',
        headers: { cookie: setCookie },
      }),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/')
  })
})
```

- [ ] **Step 5: Run tests + typecheck**

```sh
npm run typecheck
npx tsx --test --test-force-exit test/auth.test.ts
npm test
```

Expected: 5 auth tests pass; full suite at 79.

If any of the dynamic-import / Router#use call fails: switch to the per-action middleware fallback noted in Step 3. Report DONE_WITH_CONCERNS noting which fallback was needed.

- [ ] **Step 6: Commit**

```sh
git add app/controllers/auth app/router.ts app/utils/render.tsx server.ts test/auth.test.ts test/routes.test.ts
git commit -m "auth: implement /auth sign-in callback sign-out with session"
```

---

### Task 5: Gate the home page in discord mode

**Goal:** Anonymous: behavior unchanged. Discord: redirect to `/auth/sign-in` if no session, otherwise pass identity to `EditorApp`.

**Files:**
- Modify: `app/controllers/home.tsx`
- Modify: `app/ui/editor/editor-app.tsx`
- Modify: `test/routes.test.ts` (extend with discord-mode gating test)

- [ ] **Step 1: Update `app/ui/editor/editor-app.tsx` to accept the auth-mode prop**

Read the current file. The component is wrapped in `clientEntry(...)` and the inner function takes `handle: Handle`. Change the type to `Handle<EditorAppProps>` and read the mode from `handle.props`.

At the top of the file, add the type:

```ts
import type { SerializableProps } from 'remix/ui'

interface EditorAppProps extends SerializableProps {
  authMode: { mode: 'anonymous' } | { mode: 'discord'; identity: { name: string; color: string } }
}
```

Change the function signature:

```ts
function EditorApp(handle: Handle<EditorAppProps>) {
```

In the setup section, replace `user = getUser()` with:

```ts
const authMode = handle.props.authMode
user = authMode.mode === 'discord' ? authMode.identity : getUser()
```

In the render function, when `authMode.mode === 'discord'`, render an additional sign-out button next to the user badge in the header. The header currently looks like:

```tsx
<header mix={headerStyle}>
  <h1 mix={titleStyle}>marky</h1>
  {user && (
    <span mix={userBadgeStyle} style={{ color: user.color }}>
      {user.name}
    </span>
  )}
</header>
```

Add a sign-out form after the user badge in discord mode. Build it as a real form so the button still works without JS:

```tsx
<header mix={headerStyle}>
  <h1 mix={titleStyle}>marky</h1>
  {user && (
    <span mix={userBadgeStyle} style={{ color: user.color }}>
      {user.name}
    </span>
  )}
  {authMode.mode === 'discord' && (
    <form method="post" action="/auth/sign-out" mix={signOutFormStyle}>
      <button type="submit" mix={signOutButtonStyle}>
        Sign out
      </button>
    </form>
  )}
</header>
```

Append two new style blocks at the bottom of the file (next to the existing styles):

```ts
const signOutFormStyle = css({
  margin: 0,
})

const signOutButtonStyle = css({
  font: 'inherit',
  background: 'transparent',
  border: '1px solid var(--ui-2)',
  color: 'var(--tx-2)',
  padding: '4px 10px',
  borderRadius: '4px',
  cursor: 'pointer',
  '&:hover': { color: 'var(--tx)', borderColor: 'var(--tx-3)' },
})
```

Make sure the style imports include `signOutFormStyle` etc. Compile-check by running:

```sh
npm run typecheck
```

- [ ] **Step 2: Update `app/controllers/home.tsx`**

```tsx
import type { BuildAction } from 'remix/fetch-router'
import { redirect } from 'remix/response/redirect'

import { loadConfig } from '../config.ts'
import { Identity } from '../middleware/auth.ts'
import { EditorPage } from '../ui/editor/editor-page.tsx'
import type { routes } from '../routes.ts'
import { render } from '../utils/render.tsx'

export const home: BuildAction<'GET', typeof routes.home> = {
  handler({ request, get }) {
    const config = loadConfig()

    if (config.auth.mode === 'anonymous') {
      return render(<EditorPage authMode={{ mode: 'anonymous' }} />, request)
    }

    let identity: { discordId: string; name: string; color: string } | null = null
    try {
      identity = (get as any)(Identity) ?? null
    } catch {
      identity = null
    }

    if (!identity) {
      return redirect('/auth/sign-in')
    }

    return render(
      <EditorPage authMode={{ mode: 'discord', identity }} />,
      request,
    )
  },
}
```

- [ ] **Step 3: Update `EditorPage` to forward the prop**

Open `app/ui/editor/editor-page.tsx`. Find where `<EditorApp />` is rendered. Change it to accept and pass through `authMode`:

```tsx
import type { SerializableProps } from 'remix/ui'

interface EditorPageProps extends SerializableProps {
  authMode: { mode: 'anonymous' } | { mode: 'discord'; identity: { name: string; color: string } }
}

export function EditorPage() {
  return (props: EditorPageProps) => (
    <html lang="en">
      <head>
        {/* ...existing head content... */}
      </head>
      <body
        mix={css({
          /* ...existing body styles... */
        })}
      >
        <EditorApp authMode={props.authMode} />
      </body>
    </html>
  )
}
```

If `EditorPage` is currently a function component returning a render closure with no props, give it the same shape as other Remix UI components. The pattern is: outer function returns inner render `(props) => JSX` so props can be passed.

- [ ] **Step 4: Wire the home controller's middleware**

For `Identity` to be in context on the home route, the session middleware must run on `/`. Currently in discord mode the session middleware is only attached to the `/auth/*` subrouter.

Move the session + identity middleware to apply globally in discord mode. Edit `app/router.ts`:

```ts
export async function createRouter(deps: RouterDeps) {
  const baseMiddleware: any[] = []

  if (deps.config.auth.mode === 'discord') {
    if (!deps.sessionStorage) {
      throw new Error('createRouter: sessionStorage is required in discord mode')
    }
    const cookie = (await import('remix/cookie')).createCookie('marky.session', {
      secrets: [deps.config.auth.sessionSecret],
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.config.auth.baseUrl.startsWith('https://'),
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })
    const { session } = await import('remix/session-middleware')
    const { identityMiddleware } = await import('./middleware/auth.ts')
    baseMiddleware.push(session(cookie, deps.sessionStorage))
    baseMiddleware.push(identityMiddleware())
  }

  const router = createFetchRouter({ middleware: baseMiddleware as any })

  router.get(routes.assets, async ({ request }) => {
    const response = await assets.fetch(request)
    return response ?? new Response('Not Found', { status: 404 })
  })

  router.map(routes.home, home)

  if (deps.config.auth.mode === 'discord') {
    const { createAuthController } = await import('./controllers/auth/controller.tsx')
    const auth = createAuthController({ auth: deps.config.auth })
    router.map(routes.auth.signIn, auth.actions.signIn)
    router.map(routes.auth.callback, auth.actions.callback)
    router.map(routes.auth.signOut, auth.actions.signOut)
  }

  return router
}
```

The `as any` casts on the middleware tuple are deliberate; the strict middleware-context typing is friction we're not getting value from in this controller.

- [ ] **Step 5: Add discord-mode home gating tests to `test/routes.test.ts`**

Append inside the existing `describe('routes', ...)`:

```ts
it('home redirects to /auth/sign-in when discord mode and no session', async () => {
  const { createMemorySessionStorage } = await import('remix/session/memory-storage')
  const sessionStorage = createMemorySessionStorage()
  const discordRouter = await createRouter({
    config: loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'cs',
      DISCORD_GUILD_ID: 'gid',
      MARKY_BASE_URL: 'http://localhost',
      SESSION_SECRET: 'sssh',
    }),
    sessionStorage,
  })

  const response = await discordRouter.fetch(new Request('http://localhost/'))
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/auth/sign-in')
})

it('home renders editor in discord mode when session has identity', async () => {
  const { createMemorySessionStorage } = await import('remix/session/memory-storage')
  const sessionStorage = createMemorySessionStorage()
  const seed = await sessionStorage.read(null)
  seed.set('identity', { discordId: '7', name: 'Jack', color: '#205ea6' })
  const cookieHeader = (await sessionStorage.save(seed))!

  const discordRouter = await createRouter({
    config: loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'cs',
      DISCORD_GUILD_ID: 'gid',
      MARKY_BASE_URL: 'http://localhost',
      SESSION_SECRET: 'sssh',
    }),
    sessionStorage,
  })

  const response = await discordRouter.fetch(
    new Request('http://localhost/', { headers: { cookie: cookieHeader } }),
  )
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.match(body, /editor-app\.tsx/)
  assert.match(body, /Sign out/)
})
```

Also add the missing `loadConfig` import at the top of the test file.

- [ ] **Step 6: Run tests + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 81 pass.

- [ ] **Step 7: Commit**

```sh
git add app/controllers/home.tsx app/router.ts app/ui/editor/editor-app.tsx app/ui/editor/editor-page.tsx test/routes.test.ts
git commit -m "home: gate / behind discord session and pass authMode to editor"
```

---

### Task 6: WebSocket identity binding

**Goal:** In discord mode, the WS upgrade reads the session cookie and binds the peer's identity. `SocketRoom` rewrites the `user` field of awareness updates from identified peers using `modifyAwarenessUpdate`.

**Files:**
- Modify: `app/middleware/sockets.ts`
- Modify: `server.ts`
- Modify: `test/socket-room.test.ts`

- [ ] **Step 1: Add an identity-aware `addPeer` to `SocketRoom`**

Open `app/middleware/sockets.ts`. Make these changes to the class:

a. Update the peer-tracking type so we can store an identity alongside the subscriptions:

```ts
interface PeerState {
  subscriptions: Set<string>
  identity?: PeerIdentity
}

export interface PeerIdentity {
  name: string
  color: string
}
```

b. Change `peers` from `Map<PeerConnection, Set<string>>` to `Map<PeerConnection, PeerState>`:

```ts
private readonly peers = new Map<PeerConnection, PeerState>()
```

Update every read/write to use `.subscriptions`. Specifically:
- In `addPeer`, change `this.peers.set(peer, new Set())` to `this.peers.set(peer, { subscriptions: new Set() })`.
- In `receive` for `MESSAGE_TYPE_OPEN_FILE`, change `this.peers.get(peer)?.add(filename)` to `this.peers.get(peer)?.subscriptions.add(filename)`.
- In `MESSAGE_TYPE_SUBDOC_AWARENESS` and `ensureSubdocBroadcaster`, change destructuring like `for (const [otherPeer, subs] of this.peers)` to `for (const [otherPeer, state] of this.peers)` and reference `state.subscriptions`.

c. Make `addPeer` accept an optional identity:

```ts
addPeer(peer: PeerConnection, identity?: PeerIdentity): void {
  this.peers.set(peer, { subscriptions: new Set(), identity })
  peer.send(encodeMessage(MESSAGE_TYPE_SYNC, Y.encodeStateAsUpdate(this.rootDoc)))
  this.sendFileList(peer)
}
```

d. Add an awareness-rewriting helper, used by both `MESSAGE_TYPE_AWARENESS` and `MESSAGE_TYPE_SUBDOC_AWARENESS` paths:

```ts
private stampIdentity(peer: PeerConnection, update: Uint8Array): Uint8Array {
  const identity = this.peers.get(peer)?.identity
  if (!identity) return update
  return modifyAwarenessUpdate(update, (state) => ({ ...state, user: identity }))
}
```

Add the import at the top:

```ts
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  modifyAwarenessUpdate,
} from 'y-protocols/awareness'
```

e. Use `stampIdentity` in the two awareness branches of `receive`:

```ts
if (messageType === MESSAGE_TYPE_AWARENESS) {
  const stamped = this.stampIdentity(peer, content)
  const frame = encodeMessage(MESSAGE_TYPE_AWARENESS, stamped)
  this.broadcast(frame, peer)
  return
}
```

```ts
if (messageType === MESSAGE_TYPE_SUBDOC_AWARENESS) {
  const { filename, payload } = decodeFileMessage(content)
  const subdoc = this.filenameToSubdoc.get(filename)
  if (!subdoc) return
  const awareness = this.ensureSubdocAwareness(filename, subdoc)
  const stamped = this.stampIdentity(peer, payload)
  applyAwarenessUpdate(awareness, stamped, peer)
  const frame = encodeFileMessage(MESSAGE_TYPE_SUBDOC_AWARENESS, filename, stamped)
  for (const [otherPeer, state] of this.peers) {
    if (otherPeer !== peer && state.subscriptions.has(filename) && otherPeer.isOpen()) {
      otherPeer.send(frame)
    }
  }
  return
}
```

- [ ] **Step 2: Add a `SocketRoom` test for the rewrite**

Append to `test/socket-room.test.ts` inside `describe('SocketRoom', () => { ... })`:

```ts
it('overwrites awareness user for peers with an identity', async () => {
  const { encodeAwarenessUpdate } = await import('y-protocols/awareness')
  const { Awareness } = await import('y-protocols/awareness')
  const { default: Y } = await import('yjs')

  // Build a real awareness frame as a peer would: a Y.Doc + Awareness
  // with a forged user state.
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalStateField('user', { name: 'forged', color: '#000000' })
  const update = encodeAwarenessUpdate(awareness, [awareness.clientID])

  const a = new FakePeer()
  const b = new FakePeer()
  room.addPeer(a, { name: 'real-jack', color: '#ff0000' })
  room.addPeer(b)

  await room.receive(a, encodeMessage(MESSAGE_TYPE_AWARENESS, update))

  const frame = b.lastFrameOfType(MESSAGE_TYPE_AWARENESS)
  assert.ok(frame)
  // Apply the broadcast frame into a fresh awareness and confirm the user
  // was rewritten to peer A's bound identity.
  const observerDoc = new Y.Doc()
  const observer = new Awareness(observerDoc)
  const { applyAwarenessUpdate } = await import('y-protocols/awareness')
  applyAwarenessUpdate(observer, frame.subarray(1), null)
  const states = Array.from(observer.getStates().values())
  assert.equal(states.length, 1)
  assert.deepEqual(states[0].user, { name: 'real-jack', color: '#ff0000' })
})
```

Also add the necessary imports at the top of the file if missing: `MESSAGE_TYPE_AWARENESS` from `app/shared/message-types.ts`.

- [ ] **Step 3: Wire the WS upgrade to read the session in `attachSockets`**

Modify the `attachSockets` signature so the caller (server.ts) can pass `authConfig` and `sessionStorage`:

```ts
import type { Cookie } from 'remix/cookie'
import type { SessionStorage } from 'remix/session'

import type { AppConfig } from '../config.ts'

export interface AttachSocketsOptions {
  store: ContentStore
  config: AppConfig
  sessionStorage?: SessionStorage
  sessionCookie?: Cookie
  path?: string
}

export function attachSockets(app: TemplatedApp, options: AttachSocketsOptions): SocketRoom {
  const room = new SocketRoom({ store: options.store })
  // ...existing rescan boot...

  app.ws<ClientData>(options.path ?? '/ws', {
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout: 60,
    upgrade(res, req, context) {
      const secWebSocketKey = req.getHeader('sec-websocket-key')
      const secWebSocketProtocol = req.getHeader('sec-websocket-protocol')
      const secWebSocketExtensions = req.getHeader('sec-websocket-extensions')
      const cookieHeader = req.getHeader('cookie') ?? ''

      let pendingIdentity: PeerIdentity | null = null

      if (options.config.auth.mode === 'discord') {
        if (!options.sessionStorage || !options.sessionCookie) {
          res.writeStatus('500 Internal Server Error').end('session not configured')
          return
        }
        // Async work in upgrade requires res.cork + res.upgrade after.
        // Read the session synchronously by parsing only the cookie value
        // we care about, then resolve the storage in the background.
        const sessionStorage = options.sessionStorage
        const sessionCookie = options.sessionCookie

        const aborted = { v: false }
        res.onAborted(() => { aborted.v = true })

        sessionCookie
          .parse(cookieHeader)
          .then((value) => sessionStorage.read(value))
          .then((session) => {
            if (aborted.v) return
            const identity = session.get('identity') as
              | { name: string; color: string; discordId: string }
              | undefined
            if (!identity) {
              res.cork(() => res.writeStatus('401 Unauthorized').end(''))
              return
            }
            res.cork(() => {
              res.upgrade<ClientData>(
                {
                  id: nextClientId++,
                  peer: undefined as unknown as UwsPeer,
                  identity: { name: identity.name, color: identity.color },
                },
                secWebSocketKey,
                secWebSocketProtocol,
                secWebSocketExtensions,
                context,
              )
            })
          })
          .catch((error) => {
            console.error('marky: ws session read failed', error)
            if (!aborted.v) res.cork(() => res.writeStatus('500').end(''))
          })
        return
      }

      // Anonymous mode: synchronous upgrade, no identity.
      res.upgrade<ClientData>(
        { id: nextClientId++, peer: undefined as unknown as UwsPeer, identity: undefined },
        secWebSocketKey,
        secWebSocketProtocol,
        secWebSocketExtensions,
        context,
      )
    },
    open(ws) {
      const peer = new UwsPeer(ws)
      ws.getUserData().peer = peer
      room.addPeer(peer, ws.getUserData().identity)
    },
    // ...message and close handlers unchanged...
  })

  return room
}
```

The existing `ClientData` type needs an optional `identity` field:

```ts
interface ClientData {
  id: number
  peer: UwsPeer
  identity?: PeerIdentity
}
```

The exact uWebSockets cookie/session-read sequence is the trickiest part of this plan. If the framework's `Cookie.parse` on the raw `cookie` header doesn't produce a value compatible with `SessionStorage.read`, fall back to reading the cookie name+value directly:

```ts
function getCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return null
}
```

then pass the full cookie header (or just the named pair) to `sessionStorage.read(...)` — the `SessionStorage.read` signature accepts `string | null`.

If `sessionStorage.read` requires a different format, log the discrepancy in your subagent report; don't guess.

- [ ] **Step 4: Update `server.ts` to pass the new options**

```ts
attachSockets(server.app, {
  store,
  config,
  // sessionStorage + sessionCookie populated below in discord mode
  ...(config.auth.mode === 'discord'
    ? await prepareDiscordWsBindings(config.auth)
    : {}),
})
```

Where `prepareDiscordWsBindings` is a small helper that produces `{ sessionStorage, sessionCookie }` from the same recipe `app/router.ts` uses. Cleaner: hoist the cookie + sessionStorage construction to the top of `server.ts` so the same instances are passed to both router and sockets:

```ts
import { createCookie } from 'remix/cookie'
import { createFsSessionStorage } from 'remix/session/fs-storage'

let sessionCookie: ReturnType<typeof createCookie> | undefined
let sessionStorage: ReturnType<typeof createFsSessionStorage> | undefined

if (config.auth.mode === 'discord') {
  sessionCookie = createCookie('marky.session', {
    secrets: [config.auth.sessionSecret],
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.auth.baseUrl.startsWith('https://'),
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })
  sessionStorage = createFsSessionStorage('./tmp/sessions')
}

const router = await createRouter({ config, sessionStorage, sessionCookie })

attachSockets(server.app, {
  store,
  config,
  sessionStorage,
  sessionCookie,
})
```

This means `RouterDeps` needs a `sessionCookie?: Cookie` field too. Update `app/router.ts` to receive it instead of constructing the cookie itself; remove the dynamic `import('remix/cookie')` from inside `createRouter` and just use the passed cookie. If `sessionCookie` is missing in discord mode, throw the same error you already throw for `sessionStorage`.

- [ ] **Step 5: Run tests + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 82 pass (81 + 1 new SocketRoom identity test).

- [ ] **Step 6: Commit**

```sh
git add app/middleware/sockets.ts app/router.ts server.ts test/socket-room.test.ts
git commit -m "ws: bind session identity on upgrade and rewrite awareness"
```

---

### Task 7: End-to-end smoke

**Goal:** Boot the server in anonymous mode, then in discord mode (without a real Discord), and confirm both produce sensible responses.

- [ ] **Step 1: Anonymous boot**

```sh
PORT=44700 timeout 8 npx tsx server.ts &
sleep 3
curl -s -o /dev/null -w "STATUS=%{http_code}\n" http://localhost:44700/
curl -s -o /dev/null -w "STATUS=%{http_code}\n" http://localhost:44700/auth/sign-in
kill %1 2>/dev/null
```

Expected: `/` returns 200, `/auth/sign-in` returns 404 (not registered in anonymous mode).

- [ ] **Step 2: Discord boot, no session**

```sh
MARKY_AUTH=discord \
DISCORD_CLIENT_ID=test \
DISCORD_CLIENT_SECRET=test \
DISCORD_GUILD_ID=test \
MARKY_BASE_URL=http://localhost:44701 \
SESSION_SECRET=test \
PORT=44701 timeout 8 npx tsx server.ts &
sleep 3
curl -s -o /dev/null -w "STATUS=%{http_code} LOC=%{redirect_url}\n" http://localhost:44701/
curl -s -o /dev/null -w "STATUS=%{http_code}\n" http://localhost:44701/auth/sign-in
kill %1 2>/dev/null
```

Expected: `/` returns 302 with `Location: /auth/sign-in`. `/auth/sign-in` returns 302 redirecting to `discord.com`.

- [ ] **Step 3: Final tests + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 82 pass.

- [ ] **Step 4: Commit (if anything was tweaked during smoke)**

If no changes, skip.

```sh
git status
# if something changed:
git add -A
git commit -m "ws: smoke fixups"
```

---

## Plan-end verification

- 82 tests pass
- Typecheck clean
- Anonymous mode: `/` 200, `/auth/*` 404
- Discord mode without session: `/` 302→`/auth/sign-in`, sign-in redirects to discord.com
- Two-tab in anonymous mode still does the realtime collaboration thing (manual)

After this plan: marky has both auth modes working end-to-end. Plan 3 will reshape the README and AGENTS docs to surface deployment guidance.

## Known judgment calls in this plan

- The router factory is `async` because the discord-mode wiring uses dynamic imports of `remix/session-middleware` and `remix/cookie`. That's deliberate: in anonymous mode we want zero overhead from session machinery.
- Middleware typing in `remix/fetch-router` is strict. `as any` casts on the middleware tuple are acceptable here because the contract that matters (`context.get(Identity)` returning `IdentityValue | null`) is enforced at the call site.
- The uWS upgrade's async session read uses `res.cork` per uWS docs to ensure the upgrade response is sent atomically. If the cork-and-upgrade sequence misbehaves in practice, the fallback is a synchronous in-memory cookie→identity lookup using a separate cache populated by the HTTP path. Don't go there unless the simple path fails.
