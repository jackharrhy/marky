# Marky Agent Guide

A real-time collaborative markdown editor built on Remix 3 (beta), ProseMirror,
and Yjs. WebSockets are served by uWebSockets via `remix/node-serve` rather
than a separate Node `http` server.

## Commands

```sh
npm i
npm start
npm test
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
- `app/controllers/home.tsx` — server-renders the editor page
- `app/data/content-store.ts` — markdown filesystem store (boundary
  validation lives here)
- `app/middleware/sockets.ts` — `SocketRoom` (transport-agnostic protocol) +
  `attachSockets` (uWebSockets adapter)
- `app/shared/` — modules used by both server and browser:
  - `constants.ts` — `PROSEMIRROR_FRAGMENT_NAME`, `MARKDOWN_EXTENSION`,
    `PERSIST_BUTTON_RESET_DELAY_MS`
  - `doc-utils.ts` — `plainTextSchema`, `textToDoc`, `docToText`
  - `message-types.ts` — wire-format message tags
  - `wire.ts` — frame encode/decode helpers
- `app/frontend/` — browser-only modules:
  - `collaborative-editor.ts` — ProseMirror EditorView bound to a Yjs subdoc
  - `socket-handler.ts` — browser counterpart to `SocketRoom`
  - `user.ts` — local identity persisted to localStorage
- `app/ui/editor/` — editor page + `EditorApp` client entry
- `app/utils/render.tsx` — JSX -> streamed HTML response
- `content/` — markdown files (gitignored except `.gitkeep`)
- `test/` — `node:test` suites
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

## Testing

- Server / router tests use `router.fetch(new Request(...))`
- `SocketRoom` tests use a `FakePeer` so we don't have to bind uWebSockets
  inside the test runner
- `node:test` is run via `tsx --test --test-force-exit` because the asset
  server keeps a watcher alive between suites

## Build-Out Notes

- Prefer putting code in the narrowest owner before introducing shared modules.
- Avoid generic dumping-ground directories like `app/lib/` or `app/components/`.
- Promote a route to `app/controllers/<name>/controller.tsx` only when it
  gains nested routes, multiple actions, or route-owned modules.
