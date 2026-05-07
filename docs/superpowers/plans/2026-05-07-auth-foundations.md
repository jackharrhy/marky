# Auth foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed config loading and a Discord API client. Server behavior is unchanged in anonymous mode; in discord mode the server still boots but `/` will fail closed (this plan does not wire OAuth yet — that comes in plan 2).

**Architecture:** Two new modules under `app/`. `config.ts` reads env once into a discriminated `AuthConfig`. `data/discord.ts` is a stateless API client plus pure helpers, with one in-memory roles cache. Both are testable without booting a server.

**Tech Stack:** Node 24 `fetch`, `node:test`, `node:assert/strict`, `tsx`, existing `app/shared/*` constants.

**Reference:** `docs/superpowers/specs/2026-05-07-auth-modes-design.md` (sections "Configuration", "Configuration module", "Discord API client").

---

## File Structure

- Create: `app/config.ts` — env loader, exports `loadConfig()` returning `{ auth, port, contentDir }`
- Create: `app/data/discord.ts` — Discord API client + pure helpers
- Create: `test/config.test.ts` — config loader tests
- Create: `test/discord.test.ts` — Discord client tests (with mocked `fetch`)
- Modify: `app/frontend/user.ts` — export `PALETTE_COLORS` so config-side code can reuse it (no behavior change)

`server.ts` is intentionally NOT modified in this plan; the existing direct env reads stay until plan 2.

---

### Task 1: Export the palette so server code can share it

**Files:**
- Modify: `app/frontend/user.ts`

The deterministic-color helper in plan 1 needs the same palette the anonymous flow uses. Make `COLORS` an exported named binding so server modules can import it without duplicating the values.

- [ ] **Step 1: Edit `app/frontend/user.ts`**

Change the existing `const COLORS = [ ... ] as const` to:

```ts
export const PALETTE_COLORS = [
  '#205ea6', // blue
  '#24837b', // cyan
  '#66800b', // green
  '#ad8301', // yellow
  '#bc5215', // orange
  '#af3029', // red
  '#5e409d', // purple
  '#a02f6f', // magenta
] as const
```

Then update the `pick(COLORS)` call inside `getUser()` to `pick(PALETTE_COLORS)`.

- [ ] **Step 2: Typecheck and run existing tests**

```sh
npm run typecheck
npm test
```

Expected: 34/34 still passing.

- [ ] **Step 3: Commit**

```sh
git add app/frontend/user.ts
git commit -m "user: export PALETTE_COLORS for reuse"
```

---

### Task 2: Write the failing config tests

**Files:**
- Create: `test/config.test.ts`

This tests env-driven config loading without any module-level singletons; `loadConfig` is a pure function over a `Record<string, string | undefined>`.

- [ ] **Step 1: Write `test/config.test.ts`**

```ts
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadConfig } from '../app/config.ts'

describe('loadConfig', () => {
  it('defaults to anonymous mode when MARKY_AUTH is unset', () => {
    const config = loadConfig({})
    assert.equal(config.auth.mode, 'anonymous')
  })

  it('treats MARKY_AUTH=anonymous as anonymous mode', () => {
    const config = loadConfig({ MARKY_AUTH: 'anonymous' })
    assert.equal(config.auth.mode, 'anonymous')
  })

  it('rejects unknown MARKY_AUTH values', () => {
    assert.throws(
      () => loadConfig({ MARKY_AUTH: 'github' }),
      /MARKY_AUTH must be "anonymous" or "discord"/,
    )
  })

  it('ignores Discord vars in anonymous mode', () => {
    const config = loadConfig({
      MARKY_AUTH: 'anonymous',
      DISCORD_CLIENT_ID: 'leftover',
      DISCORD_CLIENT_SECRET: 'leftover',
    })
    assert.equal(config.auth.mode, 'anonymous')
  })

  it('parses discord mode with all required vars', () => {
    const config = loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'csecret',
      DISCORD_GUILD_ID: 'gid',
      MARKY_BASE_URL: 'https://marky.example.com',
      SESSION_SECRET: 'sssh',
    })
    assert.equal(config.auth.mode, 'discord')
    if (config.auth.mode !== 'discord') throw new Error('unreachable')
    assert.equal(config.auth.clientId, 'cid')
    assert.equal(config.auth.clientSecret, 'csecret')
    assert.equal(config.auth.guildId, 'gid')
    assert.equal(config.auth.baseUrl, 'https://marky.example.com')
    assert.equal(config.auth.sessionSecret, 'sssh')
    assert.equal(config.auth.botToken, undefined)
  })

  it('captures the optional bot token in discord mode', () => {
    const config = loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'csecret',
      DISCORD_GUILD_ID: 'gid',
      MARKY_BASE_URL: 'https://marky.example.com',
      SESSION_SECRET: 'sssh',
      DISCORD_BOT_TOKEN: 'bot',
    })
    assert.equal(config.auth.mode === 'discord' && config.auth.botToken, 'bot')
  })

  it('lists every missing var in discord mode', () => {
    assert.throws(
      () => loadConfig({ MARKY_AUTH: 'discord' }),
      (error: Error) => {
        assert.match(error.message, /DISCORD_CLIENT_ID/)
        assert.match(error.message, /DISCORD_CLIENT_SECRET/)
        assert.match(error.message, /DISCORD_GUILD_ID/)
        assert.match(error.message, /MARKY_BASE_URL/)
        assert.match(error.message, /SESSION_SECRET/)
        return true
      },
    )
  })

  it('strips trailing slash from MARKY_BASE_URL', () => {
    const config = loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'csecret',
      DISCORD_GUILD_ID: 'gid',
      MARKY_BASE_URL: 'https://marky.example.com/',
      SESSION_SECRET: 'sssh',
    })
    assert.equal(config.auth.mode === 'discord' && config.auth.baseUrl, 'https://marky.example.com')
  })

  it('parses PORT and MARKY_CONTENT_DIR with sensible defaults', () => {
    const config = loadConfig({})
    assert.equal(config.port, 44100)
    assert.equal(typeof config.contentDir, 'string')
    assert.ok(config.contentDir.endsWith('content'))
  })

  it('parses a custom PORT', () => {
    const config = loadConfig({ PORT: '8080' })
    assert.equal(config.port, 8080)
  })

  it('rejects an invalid PORT', () => {
    assert.throws(() => loadConfig({ PORT: 'not-a-number' }), /PORT must be a number/)
  })
})
```

- [ ] **Step 2: Run the new test, expect failure**

```sh
npx tsx --test --test-force-exit test/config.test.ts
```

Expected: every test fails because `app/config.ts` doesn't exist. The runner will print "Cannot find module '../app/config.ts'".

---

### Task 3: Implement `app/config.ts`

**Files:**
- Create: `app/config.ts`

- [ ] **Step 1: Write `app/config.ts`**

```ts
import * as path from 'node:path'

// Typed env-derived configuration. Read once at startup via loadConfig() so
// failures surface before the server binds a port.

export type AuthConfig =
  | { mode: 'anonymous' }
  | {
      mode: 'discord'
      clientId: string
      clientSecret: string
      guildId: string
      baseUrl: string
      sessionSecret: string
      botToken?: string
    }

export interface AppConfig {
  auth: AuthConfig
  port: number
  contentDir: string
}

const DEFAULT_PORT = 44100

const DISCORD_REQUIRED = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_GUILD_ID',
  'MARKY_BASE_URL',
  'SESSION_SECRET',
] as const

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const mode = env.MARKY_AUTH ?? 'anonymous'
  if (mode !== 'anonymous' && mode !== 'discord') {
    throw new Error(`MARKY_AUTH must be "anonymous" or "discord", got "${mode}"`)
  }

  return {
    auth: mode === 'anonymous' ? { mode: 'anonymous' } : loadDiscordConfig(env),
    port: parsePort(env.PORT),
    contentDir: parseContentDir(env.MARKY_CONTENT_DIR),
  }
}

function loadDiscordConfig(env: Record<string, string | undefined>): AuthConfig {
  const missing = DISCORD_REQUIRED.filter((key) => !env[key])
  if (missing.length > 0) {
    throw new Error(
      `MARKY_AUTH=discord requires the following env vars: ${missing.join(', ')}`,
    )
  }

  const baseUrl = env.MARKY_BASE_URL!.replace(/\/+$/, '')

  return {
    mode: 'discord',
    clientId: env.DISCORD_CLIENT_ID!,
    clientSecret: env.DISCORD_CLIENT_SECRET!,
    guildId: env.DISCORD_GUILD_ID!,
    baseUrl,
    sessionSecret: env.SESSION_SECRET!,
    botToken: env.DISCORD_BOT_TOKEN || undefined,
  }
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`PORT must be a number, got "${raw}"`)
  }
  return parsed
}

function parseContentDir(raw: string | undefined): string {
  return path.resolve(raw && raw.length > 0 ? raw : path.join(process.cwd(), 'content'))
}
```

- [ ] **Step 2: Run the config tests, expect pass**

```sh
npx tsx --test --test-force-exit test/config.test.ts
```

Expected: 10 tests pass.

- [ ] **Step 3: Run the full test suite + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 44 tests pass total (34 existing + 10 new).

- [ ] **Step 4: Commit**

```sh
git add app/config.ts test/config.test.ts
git commit -m "config: add typed env loader with anonymous/discord modes"
```

---

### Task 4: Write the failing Discord client tests

**Files:**
- Create: `test/discord.test.ts`

These tests use a `fetch` mock injected per call. The `discord.ts` module accepts an optional `fetchImpl` so tests can stub HTTP without touching globals.

- [ ] **Step 1: Write `test/discord.test.ts`**

```ts
import * as assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import {
  _resetRolesCacheForTests,
  deterministicPaletteColor,
  exchangeCode,
  fetchGuildMember,
  fetchGuildRoles,
  resolveDisplayName,
  resolveRoleColor,
  type Role,
} from '../app/data/discord.ts'
import { PALETTE_COLORS } from '../app/frontend/user.ts'

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }
  return { fetchImpl, calls }
}

describe('exchangeCode', () => {
  it('posts the OAuth body and parses the response', async () => {
    const { fetchImpl, calls } = mockFetch(
      () =>
        new Response(
          JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 604800 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )

    const result = await exchangeCode(
      {
        clientId: 'cid',
        clientSecret: 'csecret',
        code: 'abc',
        redirectUri: 'https://m/callback',
      },
      fetchImpl,
    )

    assert.equal(result.accessToken, 'tok')
    assert.equal(result.tokenType, 'Bearer')
    assert.equal(result.expiresIn, 604800)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://discord.com/api/oauth2/token')
    assert.equal(calls[0].init?.method, 'POST')

    const body = String(calls[0].init?.body)
    assert.match(body, /client_id=cid/)
    assert.match(body, /client_secret=csecret/)
    assert.match(body, /code=abc/)
    assert.match(body, /grant_type=authorization_code/)
    assert.match(body, /redirect_uri=https%3A%2F%2Fm%2Fcallback/)
  })

  it('throws on non-2xx', async () => {
    const { fetchImpl } = mockFetch(
      () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    )
    await assert.rejects(
      () =>
        exchangeCode(
          { clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' },
          fetchImpl,
        ),
      /Discord token exchange failed/,
    )
  })
})

describe('fetchGuildMember', () => {
  it('returns a parsed member on 200', async () => {
    const { fetchImpl, calls } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            nick: 'serverNick',
            roles: ['111', '222'],
            user: { id: '42', username: 'jack', global_name: 'Jack H' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )

    const member = await fetchGuildMember(
      { accessToken: 'tok', guildId: 'gid' },
      fetchImpl,
    )

    assert.ok(member)
    assert.equal(member.nick, 'serverNick')
    assert.deepEqual(member.roleIds, ['111', '222'])
    assert.equal(member.user.id, '42')
    assert.equal(member.user.username, 'jack')
    assert.equal(member.user.globalName, 'Jack H')
    assert.equal(calls[0].url, 'https://discord.com/api/users/@me/guilds/gid/member')
    assert.equal(
      (calls[0].init?.headers as Record<string, string>)['Authorization'],
      'Bearer tok',
    )
  })

  it('returns null on 404', async () => {
    const { fetchImpl } = mockFetch(() => new Response('', { status: 404 }))
    const result = await fetchGuildMember(
      { accessToken: 'tok', guildId: 'gid' },
      fetchImpl,
    )
    assert.equal(result, null)
  })

  it('handles a missing global_name', async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            nick: null,
            roles: [],
            user: { id: '7', username: 'someone', global_name: null },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const member = await fetchGuildMember(
      { accessToken: 'tok', guildId: 'gid' },
      fetchImpl,
    )
    assert.ok(member)
    assert.equal(member.user.globalName, null)
  })

  it('throws on other non-2xx errors', async () => {
    const { fetchImpl } = mockFetch(() => new Response('rate limited', { status: 429 }))
    await assert.rejects(
      () => fetchGuildMember({ accessToken: 'tok', guildId: 'gid' }, fetchImpl),
      /Discord guild-member fetch failed/,
    )
  })
})

describe('fetchGuildRoles + caching', () => {
  beforeEach(() => _resetRolesCacheForTests())

  it('uses the bot token and parses roles', async () => {
    const { fetchImpl, calls } = mockFetch(
      () =>
        new Response(
          JSON.stringify([
            { id: '1', name: 'admin', color: 0xff0000, position: 5 },
            { id: '2', name: 'member', color: 0, position: 1 },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )

    const roles = await fetchGuildRoles(
      { botToken: 'bot', guildId: 'gid' },
      { fetchImpl, now: () => 0 },
    )
    assert.equal(roles.length, 2)
    assert.equal(roles[0].id, '1')
    assert.equal(roles[0].color, 0xff0000)
    assert.equal(roles[0].position, 5)
    assert.equal(calls[0].url, 'https://discord.com/api/guilds/gid/roles')
    assert.equal(
      (calls[0].init?.headers as Record<string, string>)['Authorization'],
      'Bot bot',
    )
  })

  it('caches results within the TTL', async () => {
    let callCount = 0
    const fetchImpl: typeof fetch = async () => {
      callCount++
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    let nowMs = 1_000
    const opts = { fetchImpl, now: () => nowMs }

    await fetchGuildRoles({ botToken: 'bot', guildId: 'gid' }, opts)
    nowMs += 30 * 60 * 1000 // 30 minutes
    await fetchGuildRoles({ botToken: 'bot', guildId: 'gid' }, opts)

    assert.equal(callCount, 1)
  })

  it('refetches after TTL expires', async () => {
    let callCount = 0
    const fetchImpl: typeof fetch = async () => {
      callCount++
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    let nowMs = 1_000
    const opts = { fetchImpl, now: () => nowMs }

    await fetchGuildRoles({ botToken: 'bot', guildId: 'gid' }, opts)
    nowMs += 61 * 60 * 1000 // 61 minutes
    await fetchGuildRoles({ botToken: 'bot', guildId: 'gid' }, opts)

    assert.equal(callCount, 2)
  })

  it('caches per guild id', async () => {
    let callCount = 0
    const fetchImpl: typeof fetch = async () => {
      callCount++
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const opts = { fetchImpl, now: () => 0 }

    await fetchGuildRoles({ botToken: 'bot', guildId: 'a' }, opts)
    await fetchGuildRoles({ botToken: 'bot', guildId: 'b' }, opts)
    assert.equal(callCount, 2)
  })
})

describe('resolveDisplayName', () => {
  const baseUser = { id: '1', username: 'jack', globalName: 'Jack H' }

  it('prefers nick when set', () => {
    assert.equal(
      resolveDisplayName({ nick: 'NickName', roleIds: [], user: baseUser }),
      'NickName',
    )
  })

  it('falls back to globalName when nick is null', () => {
    assert.equal(
      resolveDisplayName({ nick: null, roleIds: [], user: baseUser }),
      'Jack H',
    )
  })

  it('falls back to username when nick and globalName are null', () => {
    assert.equal(
      resolveDisplayName({ nick: null, roleIds: [], user: { ...baseUser, globalName: null } }),
      'jack',
    )
  })

  it('treats empty-string nick as falsy', () => {
    assert.equal(
      resolveDisplayName({ nick: '', roleIds: [], user: baseUser }),
      'Jack H',
    )
  })
})

describe('resolveRoleColor', () => {
  const roles: Role[] = [
    { id: '1', name: 'everyone', color: 0, position: 0 },
    { id: '2', name: 'support', color: 0x00ff00, position: 3 },
    { id: '3', name: 'admin', color: 0xff0000, position: 10 },
    { id: '4', name: 'transparent-top', color: 0, position: 99 },
  ]

  it('returns the highest-positioned colored role', () => {
    assert.equal(resolveRoleColor(['1', '2', '3', '4'], roles), '#ff0000')
  })

  it('skips roles with color zero, even if they are higher', () => {
    assert.equal(resolveRoleColor(['2', '4'], roles), '#00ff00')
  })

  it('returns null when all roles have color zero', () => {
    assert.equal(resolveRoleColor(['1', '4'], roles), null)
  })

  it('returns null with no role ids', () => {
    assert.equal(resolveRoleColor([], roles), null)
  })

  it('ignores role ids not in the role list', () => {
    assert.equal(resolveRoleColor(['unknown'], roles), null)
  })

  it('formats colors with leading zeros', () => {
    const padded: Role[] = [{ id: '1', name: 'low', color: 0x00ff00, position: 1 }]
    assert.equal(resolveRoleColor(['1'], padded), '#00ff00')
  })
})

describe('deterministicPaletteColor', () => {
  it('returns a value from the shared palette', () => {
    const color = deterministicPaletteColor('123')
    assert.ok(PALETTE_COLORS.includes(color as (typeof PALETTE_COLORS)[number]))
  })

  it('is stable for the same id', () => {
    assert.equal(deterministicPaletteColor('abc'), deterministicPaletteColor('abc'))
  })

  it('differs for sufficiently different ids', () => {
    // Sanity check: with 8 buckets and many distinct ids we should see
    // more than one color across a small sample.
    const seen = new Set<string>()
    for (let i = 0; i < 32; i++) seen.add(deterministicPaletteColor(`user-${i}`))
    assert.ok(seen.size > 1, 'expected multiple palette colors across distinct ids')
  })
})
```

- [ ] **Step 2: Run the new test, expect failure**

```sh
npx tsx --test --test-force-exit test/discord.test.ts
```

Expected: every test fails because `app/data/discord.ts` doesn't exist.

---

### Task 5: Implement `app/data/discord.ts`

**Files:**
- Create: `app/data/discord.ts`

- [ ] **Step 1: Write `app/data/discord.ts`**

```ts
import { PALETTE_COLORS } from '../frontend/user.ts'

// Discord API client. Stateless except for the per-guild roles cache.
// Every fetch-using export accepts an optional `fetchImpl` so tests can
// inject a stub without touching globals.

const API = 'https://discord.com/api'
const ROLES_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

export interface GuildMember {
  nick: string | null
  roleIds: string[]
  user: { id: string; username: string; globalName: string | null }
}

export interface Role {
  id: string
  name: string
  color: number // 0 = no color
  position: number
}

export interface ExchangeArgs {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}

export interface ExchangeResult {
  accessToken: string
  tokenType: string
  expiresIn: number
}

export async function exchangeCode(
  args: ExchangeArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
  })

  const response = await fetchImpl(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Discord token exchange failed: ${response.status} ${text}`)
  }

  const json = (await response.json()) as {
    access_token: string
    token_type: string
    expires_in: number
  }
  return {
    accessToken: json.access_token,
    tokenType: json.token_type,
    expiresIn: json.expires_in,
  }
}

export async function fetchGuildMember(
  args: { accessToken: string; guildId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GuildMember | null> {
  const response = await fetchImpl(`${API}/users/@me/guilds/${args.guildId}/member`, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  })

  if (response.status === 404) return null
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Discord guild-member fetch failed: ${response.status} ${text}`)
  }

  const json = (await response.json()) as {
    nick: string | null
    roles: string[]
    user: { id: string; username: string; global_name: string | null }
  }
  return {
    nick: json.nick,
    roleIds: json.roles,
    user: {
      id: json.user.id,
      username: json.user.username,
      globalName: json.user.global_name,
    },
  }
}

interface CachedRoles {
  roles: Role[]
  fetchedAt: number
}
const rolesCache = new Map<string, CachedRoles>()

export interface FetchGuildRolesOptions {
  fetchImpl?: typeof fetch
  now?: () => number
}

export async function fetchGuildRoles(
  args: { botToken: string; guildId: string },
  options: FetchGuildRolesOptions = {},
): Promise<Role[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now

  const cached = rolesCache.get(args.guildId)
  if (cached && now() - cached.fetchedAt < ROLES_CACHE_TTL_MS) {
    return cached.roles
  }

  const response = await fetchImpl(`${API}/guilds/${args.guildId}/roles`, {
    headers: { Authorization: `Bot ${args.botToken}` },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Discord roles fetch failed: ${response.status} ${text}`)
  }

  const json = (await response.json()) as Array<{
    id: string
    name: string
    color: number
    position: number
  }>
  const roles: Role[] = json.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
  }))

  rolesCache.set(args.guildId, { roles, fetchedAt: now() })
  return roles
}

// Test-only: reset the in-memory cache.
export function _resetRolesCacheForTests(): void {
  rolesCache.clear()
}

export function resolveDisplayName(member: GuildMember): string {
  if (member.nick) return member.nick
  if (member.user.globalName) return member.user.globalName
  return member.user.username
}

export function resolveRoleColor(roleIds: string[], roles: Role[]): string | null {
  if (roleIds.length === 0) return null

  const byId = new Map(roles.map((r) => [r.id, r]))
  let best: Role | null = null
  for (const id of roleIds) {
    const role = byId.get(id)
    if (!role || role.color === 0) continue
    if (!best || role.position > best.position) best = role
  }

  if (!best) return null
  return `#${best.color.toString(16).padStart(6, '0')}`
}

export function deterministicPaletteColor(userId: string): string {
  // Simple FNV-1a-ish hash; we just need a stable bucket. Discord ids are
  // numeric strings but we treat them as opaque.
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  }
  return PALETTE_COLORS[hash % PALETTE_COLORS.length]
}
```

Note on the cache: it's module-scoped on purpose so the production server reuses it across requests. Tests that need cache isolation can call `_resetRolesCacheForTests()`.

- [ ] **Step 2: Run the discord tests, expect pass**

```sh
npx tsx --test --test-force-exit test/discord.test.ts
```

Expected: 23 tests pass (2 exchangeCode, 4 fetchGuildMember, 4 fetchGuildRoles, 4 resolveDisplayName, 6 resolveRoleColor, 3 deterministicPaletteColor).

- [ ] **Step 3: Run the full test suite + typecheck**

```sh
npm run typecheck
npm test
```

Expected: every test passes (existing 34 + config 10 + discord 23 = 67).

- [ ] **Step 4: Commit**

```sh
git add app/data/discord.ts test/discord.test.ts
git commit -m "data: add discord api client and pure helpers"
```

---

### Task 6: Verify the asset server still denies the new server-only module

**Files:**
- Modify (no functional change): verify `app/assets.ts` `deny` rules cover `app/data/`

The asset server already has `deny: ['app/**/*.server.*', 'app/data/**', 'app/middleware/**']`. The new `app/data/discord.ts` and `app/config.ts` should NOT be reachable from the browser.

- [ ] **Step 1: Add a routes test asserting `/assets/app/data/discord.ts` does not 200**

Append to `test/routes.test.ts`, inside `describe('routes', () => { ... })`:

```ts
it('asset route denies app/data/discord.ts', async () => {
  const url = 'http://localhost' + routes.assets.href({ path: 'app/data/discord.ts' })
  const response = await router.fetch(new Request(url))
  assert.notEqual(response.status, 200)
})

it('asset route denies app/config.ts', async () => {
  const url = 'http://localhost' + routes.assets.href({ path: 'app/config.ts' })
  const response = await router.fetch(new Request(url))
  // app/config.ts is at the app root; allow rules don't match it, so the
  // asset server should not serve it.
  assert.notEqual(response.status, 200)
})
```

- [ ] **Step 2: Run the routes test**

```sh
npx tsx --test --test-force-exit test/routes.test.ts
```

Expected: existing tests still pass plus the two new ones.

- [ ] **Step 3: Commit**

```sh
git add test/routes.test.ts
git commit -m "test: deny new server-only modules from asset routes"
```

---

## Plan-end verification

- [ ] Full test suite + typecheck

```sh
npm run typecheck
npm test
```

Both exit 0.

- [ ] Boot the server and make sure anonymous mode is still working

```sh
PORT=44500 npx tsx server.ts &
sleep 3
curl -s -o /dev/null -w "STATUS=%{http_code}\n" http://localhost:44500/
kill %1 2>/dev/null
```

Expected: STATUS=200, log says "marky is running on http://localhost:44500".

After this plan: server still boots, anonymous mode still works, no behavior change. The new modules are isolated and tested but not yet wired into request flow. Plan 2 picks up the OAuth flow and hooks the config and Discord client into routes + sockets.
