# Docs reshape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure `README.md` so it leads with deployment guidance (Docker, env vars, auth-mode matrix, Discord setup) and pushes development guidance (commands, layout, dev loop) below. Update `AGENTS.md` to reflect the new auth modes and identity overwrite on awareness frames.

**Architecture:** Doc-only changes. No code edits. No tests change. Single commit.

**Reference:** `docs/superpowers/specs/2026-05-07-auth-modes-design.md` §"Documentation changes". The auth feature is implemented and merged; this plan just makes the README and AGENTS reflect that.

---

### Task 1: Reshape `README.md` (deployment-first)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md` with the new structure**

```md
# marky

A real-time collaborative markdown editor. Each `.md` file under `content/`
becomes a Yjs subdoc that any number of browsers can edit together over a
single WebSocket. Edits stay in memory until you click "Persist".

## Stack

- Remix 3 (single `remix` package, served via `remix/node-serve` on uWebSockets)
- ProseMirror + Yjs + y-prosemirror for the collaborative editor
- y-protocols/awareness for cursors and presence

## Running marky

### Docker quickstart

```sh
docker run --rm -p 44100:44100 \
  -v "$PWD/content":/app/content \
  ghcr.io/jackharrhy/marky:latest
```

Open http://localhost:44100. Anonymous-mode editor; everyone gets a random
name and color from a small palette.

### Auth modes

`MARKY_AUTH` selects how users are identified.

| Mode | Required env | What you get |
| --- | --- | --- |
| `anonymous` (default) | none | Browser-generated identity; everyone shares the same edit URL |
| `discord` | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`, `MARKY_BASE_URL`, `SESSION_SECRET` | Discord OAuth gate. Only members of the configured guild can edit. Display name is the Discord nickname / global name / username. Color is a stable palette color hashed from the user id. |
| `discord` + `DISCORD_BOT_TOKEN` | same as above + bot in the guild | Same as discord mode, plus user color is the highest-positioned colored Discord role. Falls back to the palette if role fetch fails. |

### Full env vars

| Var | Mode | Required | Description |
| --- | --- | --- | --- |
| `MARKY_AUTH` | both | no | `anonymous` (default) or `discord` |
| `PORT` | both | no | Listen port (default `44100`) |
| `MARKY_CONTENT_DIR` | both | no | Path to the markdown directory (default `./content`); created on first run |
| `DISCORD_CLIENT_ID` | discord | yes | OAuth client id |
| `DISCORD_CLIENT_SECRET` | discord | yes | OAuth client secret |
| `DISCORD_GUILD_ID` | discord | yes | Snowflake of the gated guild |
| `MARKY_BASE_URL` | discord | yes | External origin (e.g. `https://marky.example.com`); used as the OAuth redirect URI prefix; trailing slashes ignored |
| `SESSION_SECRET` | discord | yes | Signs the session cookie |
| `DISCORD_BOT_TOKEN` | discord | no | Enables true role color resolution |

In discord mode, missing required env vars cause the server to exit with a
list of what's missing before binding the port.

### Setting up Discord OAuth (when using `MARKY_AUTH=discord`)

1. Create a new application at <https://discord.com/developers/applications>.
2. In the **OAuth2** tab, add a redirect: `<MARKY_BASE_URL>/auth/callback`.
3. Copy `CLIENT ID` to `DISCORD_CLIENT_ID` and `CLIENT SECRET` to
   `DISCORD_CLIENT_SECRET`.
4. The right-click → "Copy Server ID" of your guild goes into
   `DISCORD_GUILD_ID` (enable Developer Mode in Discord settings to see
   that menu).
5. (Optional, for true role color) Create a bot under the same application,
   invite it into the guild with no special permissions needed beyond the
   default, copy the bot token into `DISCORD_BOT_TOKEN`. The bot doesn't
   need to do anything in chat — it just unlocks `GET /guilds/{id}/roles`.

### Content directory

By default the server reads and writes markdown files in `./content/` and
creates the directory on first run. Override with `MARKY_CONTENT_DIR` to
point at a vault elsewhere on disk:

```sh
MARKY_CONTENT_DIR=~/notes npm start
```

You can also symlink `content/` to an existing vault — `content` is
gitignored.

## Development

### Requirements

Node `>=24.3.0`.

### Commands

```sh
npm i
npm run dev        # tsx watch, restarts on changes
npm start          # http://localhost:44100
npm test           # full test suite
npm run typecheck
```

### Layout

```
app/
  routes.ts                     route contract
  router.ts                     wires routes to controllers
  assets.ts                     compiles browser modules from source
  config.ts                     env -> typed AuthConfig
  controllers/
    home.tsx                    server-renders the editor shell
    auth/                       /auth/* in discord mode (sign-in, callback, sign-out, not-in-guild page)
  data/
    content-store.ts            filesystem read/write/list
    discord.ts                  Discord API client + helpers
  middleware/
    auth.ts                     Identity context key + identityMiddleware
    sockets.ts                  transport-agnostic SocketRoom + uWS adapter (with identity overwrite)
  shared/                       constants, doc utils, wire format, palette (used by both sides)
  frontend/                     browser-only modules (editor, socket client, anonymous user)
  ui/editor/                    editor page + EditorApp client entry
  utils/render.tsx              JSX -> HTML response
content/                        markdown files (gitignored)
test/                           node:test suites
server.ts                       boots Remix + attaches WebSocket
```
```

- [ ] **Step 2: Diff to confirm the new content is what you wrote**

```sh
git diff README.md | head -40
```

- [ ] **Step 3: Commit**

```sh
git add README.md
git commit -m "readme: deployment-first restructure with auth-mode matrix"
```

---

### Task 2: Update `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the Layout section to mention the new modules**

The existing Layout section lists `app/middleware/sockets.ts`, `app/data/content-store.ts`, etc. Add three new bullets in the right alphabetical place:

```
- `app/config.ts` — typed env loader (`AuthConfig`, `loadConfig(env?)`)
- `app/data/discord.ts` — Discord API client (`exchangeCode`, `fetchGuildMember`, `fetchGuildRoles`, `resolveDisplayName`, `resolveRoleColor`, `deterministicPaletteColor`)
- `app/middleware/auth.ts` — `Identity` context key + `identityMiddleware`
- `app/controllers/auth/` — `/auth/*` routes registered only in discord mode
- `app/shared/palette.ts` — fixed color palette shared between server and browser
```

- [ ] **Step 2: Add an "Auth modes" section after "Server Architecture"**

```md
## Auth Modes

`MARKY_AUTH` switches behavior between two deployment modes selected at boot:

- `anonymous` (default): browser generates `{ name, color }` via
  `app/frontend/user.ts`, persisted in `localStorage`. The WebSocket
  upgrade is open; awareness is client-driven. No `/auth/*` routes are
  registered.
- `discord`: requires `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
  `DISCORD_GUILD_ID`, `MARKY_BASE_URL`, `SESSION_SECRET`. The router gets
  global session middleware. `/` redirects to `/auth/sign-in` when there's
  no session. The OAuth callback verifies guild membership via
  `GET /users/@me/guilds/{id}/member` and renders `NotInGuildPage` (403)
  on a 404. Optional `DISCORD_BOT_TOKEN` unlocks
  `GET /guilds/{id}/roles` so colors come from the user's highest
  Discord role; otherwise color is a stable palette color hashed from
  the user id via `deterministicPaletteColor`.

Identity is non-spoofable across the WebSocket layer in discord mode:
the upgrade handler reads the session cookie via `Cookie.parse` +
`SessionStorage.read`, binds the identity to the peer, and `SocketRoom`
rewrites the `user` field of awareness frames via
`modifyAwarenessUpdate(update, fn)` before broadcasting. Anonymous mode
trusts client-supplied awareness as before.
```

- [ ] **Step 2: Commit**

```sh
git add AGENTS.md
git commit -m "agents: document auth modes and ws identity overwrite"
```

---

## Plan-end verification

- [ ] Read both docs end-to-end as a fresh user would. Specifically check:
  - Can a deploy operator who only reads the README understand how to run discord mode?
  - Does AGENTS.md prepare an agent for the auth-modes territory before they touch code?
- [ ] `npm run typecheck` and `npm test` still pass (they should — no code changed).
- [ ] No straggling commits or unstaged files.
