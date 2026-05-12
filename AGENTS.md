# Marky Agent Guide

A real-time collaborative markdown editor built on Remix 3 (beta), ProseMirror,
and Yjs. WebSockets are served by uWebSockets via `remix/node-serve` rather
than a separate Node `http` server.

## Commands

```sh
npm i
npm start
npm test                     # remix test, runs coverage by default
npm run test:watch           # re-run on file changes
npm run typecheck
```

## Building Features

Refer to ./.agents/skills/remix/SKILL.md

## Layout

- `app/routes.ts` — URL contract
- `app/router.ts` — wires routes to controllers
- `app/assets.ts` — compiles browser modules from `app/assets/`, `app/frontend/`,
  `app/shared/`, and `app/ui/`. Server-only modules under `app/data/` and
  `app/middleware/` are denied.
- `app/config.ts` — typed env loader (`AuthConfig`, `loadConfig(env?)`)
- `app/controllers/home.tsx` — server-renders the editor page
- `app/controllers/auth/` — `/auth/*` routes registered only in discord mode
- `app/data/content-store.ts` — markdown filesystem store (boundary
  validation lives here)
- `app/data/discord.ts` — Discord API client (`exchangeCode`,
  `fetchGuildMember`, `fetchGuildRoles`, `resolveDisplayName`,
  `resolveRoleColor`, `deterministicPaletteColor`)
- `app/middleware/auth.ts` — `Identity` context key + `identityMiddleware`
- `app/middleware/sockets.ts` — `SocketRoom` (transport-agnostic protocol) +
  `attachSockets` (uWebSockets adapter)
- `app/shared/` — modules used by both server and browser:
  - `constants.ts` — `PROSEMIRROR_FRAGMENT_NAME`, `MARKDOWN_EXTENSION`,
    `PERSIST_BUTTON_RESET_DELAY_MS`
  - `doc-utils.ts` — `plainTextSchema`, `textToDoc`, `docToText`
  - `message-types.ts` — wire-format message tags
  - `palette.ts` — fixed color palette shared between server and browser
  - `wire.ts` — frame encode/decode helpers
- `app/frontend/` — browser-only modules:
  - `collaborative-editor.ts` — ProseMirror EditorView bound to a Yjs subdoc
  - `socket-handler.ts` — browser counterpart to `SocketRoom`
  - `user.ts` — local identity persisted to localStorage
- `app/ui/editor/` — editor page + `EditorApp` client entry
- `app/utils/render.tsx` — JSX -> streamed HTML response
- `content/` — markdown files (gitignored except `.gitkeep`)
- `test/` — `remix/test` suites (configured by `remix-test.config.ts`)
- `server.ts` — boots Remix + calls `attachSockets`

## Wire Protocol

All frames are binary `Uint8Array`. The first byte is one of the
`MESSAGE_TYPE_*` tags from `app/shared/message-types.ts`. File-scoped frames
(`SUBDOC_*`) prepend a single-byte filename length followed by the UTF-8
filename, then the payload. Use the helpers in `app/shared/wire.ts` instead
of hand-encoding.

## Editor Architecture

The home page server-renders an empty shell. The interactive workspace is a
single `clientEntry` (`EditorApp`) that owns:

- the WebSocket and `SocketHandler`
- one `Y.Doc` root + per-file subdocs (mirrored from the server's `SocketRoom`)
- the file list, current filename, and persist button state
- the ProseMirror `EditorView` (mounted via a `ref` mixin)

The setup phase runs both during SSR and on hydration; anything that touches
`window`, `localStorage`, or opens a WebSocket is gated behind
`typeof window !== 'undefined'`.

## Server Architecture

`SocketRoom` is a plain class with a `PeerConnection` interface — it does not
know it's running on uWebSockets. `attachSockets(app, options)` is the thin
adapter that creates a `SocketRoom`, calls `app.ws('/ws', { ... })`, and wires
each uWS WebSocket as a `PeerConnection`. This separation makes the protocol
unit-testable without binding a real port.

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

## Persistence and Git

Edits to a file debounce for `MARKY_PERSIST_IDLE_MS` (default 60s) before
being flushed to disk. When `MARKY_GIT_REPO` is set, the flush also runs
`git add`/`git mv`/`git rm` + `git commit` in that repo, authored as
`marky-bot` with a message that records the Discord (or anonymous)
usernames of the editors who touched the file during the debounce window.
A separate interval (`MARKY_PUSH_INTERVAL_MS`, default 5 min) pushes
accumulated commits via HTTPS using `MARKY_GIT_PAT` when push is enabled.

`SocketRoom` tracks pending operations per-filename with merge semantics:
edit + rename + edit collapses to a single rename commit; rename + delete
collapses to a single delete commit. The pending op's `oldName` is
preserved across stacked renames so A → B → C produces one
`rename A.md → C.md` commit.

File rename and delete operations come in over the wire as
`MESSAGE_TYPE_RENAME_FILE` and `MESSAGE_TYPE_DELETE_FILE`. Failures
(e.g. rename collisions) are reported to the requesting peer via
`MESSAGE_TYPE_ERROR`, which the editor surfaces as a toast.

The editor name attribution for a delete or rename is captured BEFORE
the room mutates state (the awareness map is destroyed during delete /
migrated during rename, so the captured name has to be taken first).

## Testing

- Use `describe`/`it` from `remix/test` and `* as assert from 'remix/assert'`.
  The runner is `remix test`, configured by `remix-test.config.ts`. Coverage
  is on by default; thresholds are 80/80/70/80 for stmts/lines/branches/fns.
- For time-dependent code (the persist debounce, the push interval) use
  `t.useFakeTimers()` and `timers.advance(ms)`. There is no `tick` method.
- Server / router tests use `router.fetch(new Request(...))`.
- `SocketRoom` tests use a `FakePeer` so we don't have to bind uWebSockets
  inside the test runner.
- Browser-only modules (`app/frontend/**`, `app/ui/**`) are excluded from
  coverage. They want component tests via `render()` from `remix/ui/test`,
  which haven't been added yet.

## Build-Out Notes

- Prefer putting code in the narrowest owner before introducing shared modules.
- Avoid generic dumping-ground directories like `app/lib/` or `app/components/`.
- Promote a route to `app/controllers/<name>/controller.tsx` only when it
  gains nested routes, multiple actions, or route-owned modules.
