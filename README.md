# marky

A real-time collaborative markdown editor. Each `.md` file under `content/`
becomes a Yjs subdoc that any number of browsers can edit together over a
single WebSocket. Edits stay in memory until you click "Persist".

## Stack

- Remix 3 (single `remix` package, served via `remix/node-serve` on uWebSockets)
- ProseMirror + Yjs + y-prosemirror for the collaborative editor
- y-protocols/awareness for cursors and presence

## Commands

```sh
npm i
npm start          # http://localhost:44100
npm test           # full test suite
npm run typecheck
```

Set `MARKY_CONTENT_DIR` to point at a different content directory. By default
the server uses `./content/` and creates the directory on first run.

## Layout

```
app/
  routes.ts                     route contract
  router.ts                     wires routes to controllers
  assets.ts                     compiles browser modules from source
  controllers/home.tsx          server-renders the editor shell
  data/content-store.ts         filesystem read/write/list
  middleware/sockets.ts         transport-agnostic SocketRoom + uWS adapter
  shared/                       constants, doc utils, wire format (used by both sides)
  frontend/                     browser-only modules (editor, socket client, user)
  ui/editor/                    editor page + EditorApp client entry
  utils/render.tsx              JSX -> HTML response
content/                        markdown files (gitignored)
test/                           node:test suites
server.ts                       boots Remix + attaches WebSocket
```
