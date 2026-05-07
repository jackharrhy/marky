# Auth modes (anonymous + Discord OAuth)

## Goal

Add a configurable authentication mode to marky:

- `MARKY_AUTH=anonymous` (default) — preserves the current browser-only
  identity flow.
- `MARKY_AUTH=discord` — gates the editor behind Discord OAuth, requires
  the user to be a member of a configured guild, and labels them with their
  Discord identity (and optionally their guild role color).

Identity in Discord mode must be non-spoofable across the WebSocket layer:
peers cannot pretend to be another signed-in user.

## Non-goals

- Allowing both modes to coexist at runtime. The operator picks one mode per
  deployment.
- Per-channel/per-document permissions. All members of the guild get the same
  access (read + write + persist).
- Refresh-token rotation or periodic guild membership re-checks. Sessions are
  a 7-day cached snapshot.
- Multi-guild support. One `DISCORD_GUILD_ID` per deployment.

## Configuration

| Var | Mode | Required | Description |
| --- | --- | --- | --- |
| `MARKY_AUTH` | both | no | `anonymous` (default) or `discord` |
| `PORT` | both | no | existing |
| `MARKY_CONTENT_DIR` | both | no | existing |
| `DISCORD_CLIENT_ID` | discord | yes | OAuth client id |
| `DISCORD_CLIENT_SECRET` | discord | yes | OAuth client secret |
| `DISCORD_GUILD_ID` | discord | yes | guild users must be a member of |
| `MARKY_BASE_URL` | discord | yes | external origin, e.g. `https://marky.example.com`; used to build the OAuth `redirect_uri` |
| `SESSION_SECRET` | discord | yes | signs the session cookie |
| `DISCORD_BOT_TOKEN` | discord | no | enables true role color via `GET /guilds/{id}/roles`; absent = palette color |

In discord mode, missing required vars cause the server to exit with a clear
error before binding the port. In anonymous mode, every Discord-related var
is ignored.

## Architecture

### File layout

```
app/
  config.ts                       env -> typed AuthConfig
  data/
    content-store.ts              (existing)
    discord.ts                    Discord API client (token exchange + 3 reads)
  middleware/
    auth.ts                       session middleware (discord) + Identity context
    sockets.ts                    (existing) extended for session-based peer identity
  controllers/
    home.tsx                      (existing) gated in discord mode
    auth/
      controller.tsx              /auth/* routes
      not-in-guild.tsx            "you must be a member of <guild>" page
  ui/
    editor/
      editor-app.tsx              (existing) accepts identity prop
  frontend/
    user.ts                       (existing) anonymous-only, unchanged
```

### Configuration module (`app/config.ts`)

Reads env once at startup and exports a discriminated union:

```ts
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

export const config: { auth: AuthConfig; port: number; contentDir: string }
```

If `MARKY_AUTH=discord`, the loader validates each required var and throws
with a list of missing vars on first read. `server.ts` calls into config at
the top so failures happen before `serve()`.

### Discord API client (`app/data/discord.ts`)

Plain functions, no shared state except the in-memory roles cache. All
return parsed types or throw on non-OK responses.

```ts
exchangeCode(args: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}): Promise<{ accessToken: string; tokenType: string; expiresIn: number }>

interface GuildMember {
  nick: string | null
  roleIds: string[]
  user: { id: string; username: string; globalName: string | null }
}

fetchGuildMember(args: {
  accessToken: string
  guildId: string
}): Promise<GuildMember | null>  // null = 404, user is not in the guild

interface Role {
  id: string
  name: string
  color: number     // 0 = no color
  position: number
}

fetchGuildRoles(args: { botToken: string; guildId: string }): Promise<Role[]>
// Cached in-memory for 1 hour, refreshed on next call after TTL.

resolveDisplayName(member: GuildMember): string
// member.nick ?? member.user.globalName ?? member.user.username

resolveRoleColor(roleIds: string[], roles: Role[]): string | null
// Highest-positioned role with color != 0, formatted as #rrggbb. null if none.
```

We do not need a separate `fetchUser` call. The
`/users/@me/guilds/{id}/member` endpoint already embeds the full `user`
object, so one call gives us identity and membership in one shot.

### Auth middleware (`app/middleware/auth.ts`)

In discord mode:

- Wires `session(cookie, fsStorage)` from `remix/session-middleware`.
- Cookie: name `marky.session`, signed with `SESSION_SECRET`, `httpOnly`,
  `sameSite=lax`, `secure` when `MARKY_BASE_URL` starts with `https://`,
  7-day max age.
- Storage: `remix/session/fs-storage` rooted at `./tmp/sessions/` (created
  on demand).
- Exports an `Identity` context key. Controllers read it to know who the
  current user is, or `null` if no session.

In anonymous mode the middleware is a no-op pass-through; controllers see
`null` for identity.

The session payload type:

```ts
export interface Identity {
  discordId: string
  name: string
  color: string
}
```

Session lifetime is owned by the cookie's `maxAge` (7 days); we don't store
an expiry inside the session payload. When the cookie expires the session
storage drops the row on next access.

### Routes (`app/routes.ts` additions)

```ts
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

In anonymous mode the `/auth/*` routes are not registered. Anything under
`/auth/` 404s through the normal router not-found path. Discord mode wires
the routes via the auth controller during router construction.

`POST /auth/sign-out` is safe without explicit CSRF protection because the
session cookie is `sameSite=lax`: a cross-site form would not include the
cookie, so the POST would be unauthenticated and the destroy would no-op.

### Auth controller (`app/controllers/auth/controller.tsx`)

```
GET /auth/sign-in
  - generates 32 random bytes -> hex `state`
  - session.set('oauth.state', state)
  - 302 to https://discord.com/api/oauth2/authorize?
      response_type=code
      &client_id=<id>
      &scope=identify%20guilds.members.read
      &redirect_uri=<MARKY_BASE_URL>/auth/callback
      &state=<state>
      &prompt=none

GET /auth/callback?code&state
  - read session.get('oauth.state'); compare to query state; if missing or
    mismatched -> 400 with "invalid OAuth state, please try again"
  - session.unset('oauth.state')
  - exchangeCode(...) -> accessToken
  - fetchGuildMember({ accessToken, guildId })
      - null (404) -> render NotInGuildPage; do NOT create session; 200 with the page
      - member -> proceed
  - name = resolveDisplayName(member)
  - if botToken set:
        roles = fetchGuildRoles(...)
        color = resolveRoleColor(member.roleIds, roles)
                ?? deterministicPaletteColor(member.user.id)
    else:
        color = deterministicPaletteColor(member.user.id)
  - session.set('identity', { discordId: member.user.id, name, color })
  - 302 to /

POST /auth/sign-out
  - session.destroy()
  - 302 to /
```

`deterministicPaletteColor(userId)` hashes the Discord user id into one of
the existing 8 palette entries from `app/frontend/user.ts`. Same user
always gets the same color across logins, even without a bot.

### Home controller gating

`app/controllers/home.tsx`:

- Anonymous mode: render `<EditorApp authMode={{ mode: 'anonymous' }} />`,
  unchanged.
- Discord mode:
    - if `Identity` context is null: 302 to `/auth/sign-in`
    - if present: render `<EditorApp authMode={{ mode: 'discord', identity }} />`

### EditorApp props

`app/ui/editor/editor-app.tsx` accepts a serializable prop:

```ts
type AuthMode =
  | { mode: 'anonymous' }
  | { mode: 'discord'; identity: { name: string; color: string } }
```

In hydration:

- `anonymous`: same as today — `getUser()` from `app/frontend/user.ts`,
  localStorage, etc.
- `discord`: skip `getUser()`; use `props.identity` directly. Add a
  "sign out" button in the header that POSTs to `/auth/sign-out`.

### WebSocket identity (`app/middleware/sockets.ts`)

`attachSockets` gains an `authConfig` parameter so the upgrade callback
knows the mode.

In discord mode the uWS upgrade handler:

1. Reads `cookie` header from the upgrade request
2. Resolves the session via the same storage backend the HTTP middleware uses
3. If no `identity` in the session: respond 401 to the upgrade and abort
4. Otherwise pass `identity` as `ClientData.identity`

`SocketRoom.addPeer(peer)` gains an optional `identity` parameter. When
present, the room overwrites the `user` field of any awareness state coming
from that peer before broadcasting, so peers cannot impersonate each other.

Implementation: when receiving `MESSAGE_TYPE_AWARENESS` or
`MESSAGE_TYPE_SUBDOC_AWARENESS` from a peer with a known identity, decode
the awareness update, replace `state.user`, re-encode, then broadcast. This
costs an awareness encode/decode per message but keeps the wire format
unchanged.

In anonymous mode the WebSocket and `SocketRoom` behave exactly as today;
no session lookup, client-supplied awareness is trusted.

### Server boot order (`server.ts`)

```
1. read config (fail fast on bad env)
2. instantiate ContentStore + ensureDir
3. if discord mode: create one SessionStorage instance + Cookie
4. build router (passes the same SessionStorage into auth middleware)
5. start serve()
6. attachSockets(server.app, { store, authConfig, sessionStorage })
7. await server.ready, install signal handlers
```

The router's session middleware and the WS upgrade handler share the same
`SessionStorage` instance. The cookie name and signing secret also come
from the same `Cookie` object so both layers decode/encode identically.

### NotInGuildPage

Static-ish JSX page rendered when `fetchGuildMember` returns null. Uses the
existing `css()` mixin styling, no client entry. Shows:

- "You must be a member of `<guild name>` to use marky."
  (We do not have the guild name without a bot. Show the guild id, or omit
  the name entirely. Decision: omit; just say "this Discord server".)
- A link back to `/auth/sign-in` to retry with a different account.

## Failure modes

| Failure | Response |
| --- | --- |
| Missing required env in discord mode | Server logs the missing vars and exits with code 1 before binding the port |
| OAuth state mismatch in callback | 400 HTML "OAuth state mismatch, please try signing in again" with retry link |
| Code exchange fails (network, bad code) | 502 HTML "Discord sign-in failed" with retry link |
| `fetchGuildMember` 404 | NotInGuildPage |
| `fetchGuildMember` other error | 502 with retry link |
| `fetchGuildRoles` fails | log and proceed; color falls back to palette |
| Session cookie corrupt | session middleware drops it; user sees login flow again |
| WS upgrade in discord mode without session | uWS respond 401 and close |

## Testing

### Unit

- `app/data/discord.ts`
    - `exchangeCode` posts the right body and parses the response
    - `fetchGuildMember` returns null on 404, parsed object on 200
    - `resolveDisplayName` precedence: nick > globalName > username
    - `resolveRoleColor` picks highest-positioned role with non-zero color
    - `resolveRoleColor` returns null when all roles have color 0
    - `resolveRoleColor` returns null with empty role list
    - role cache: hits the network once within TTL, twice across TTL
- `app/config.ts`
    - anonymous mode: ignores Discord vars even if set
    - discord mode: throws listing every missing var
    - discord mode happy path: returns the typed object

### Integration (`router.fetch`)

- `/auth/sign-in` 302s to `discord.com/api/oauth2/authorize` with the right
  query params and a state token in the session
- `/auth/callback` happy path with mocked Discord HTTP creates a session
  and 302s to `/`
- `/auth/callback` with state mismatch returns 400
- `/auth/callback` with not-in-guild Discord response renders NotInGuildPage,
  does not create a session
- `/auth/sign-out` destroys the session and 302s to `/`
- `/` in discord mode without session 302s to `/auth/sign-in`
- `/` in discord mode with session renders EditorApp with the identity prop
- `/` in anonymous mode renders EditorApp with `mode: 'anonymous'`

### `SocketRoom`

- New test: in identity-aware mode, a peer sending awareness with a forged
  `user.name` has it replaced before broadcast to other peers
- Existing tests pass unchanged in identity-less mode

## Documentation changes

`README.md` is restructured per the earlier conversation:

- Top: **Running marky** (deployment focus)
    - Docker quickstart
    - Full env var table
    - Auth mode matrix:
        - anonymous: no required vars
        - discord (no bot): list of vars, "users get a stable palette color"
        - discord (with bot): same plus "users get their highest Discord role color"
    - Notes on creating a Discord OAuth app and bot
- Bottom: **Development** (npm run dev, layout, commands)

`AGENTS.md` gets a new section under "Server architecture" describing the
identity overwrite on awareness frames and the auth modes.

## Out of scope (explicitly)

- Multi-guild support
- Role-based permissions (e.g. moderators can delete files)
- Persistent identity beyond 7 days; users sign in again after expiry
- Refreshing access tokens; we never re-call Discord during a session
- Pruning expired session files; rely on a future cron / restart cleanup
