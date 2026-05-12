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
| `SESSION_SECRET` | discord | yes | Signs the session cookie |
| `MARKY_BASE_URL` | discord | no | External origin (e.g. `https://marky.example.com`) used as the OAuth redirect URI prefix; defaults to `http://localhost:<PORT>` for local dev; trailing slashes ignored |
| `MARKY_GIT_REPO` | both | no | Absolute path to a git repo. When set, marky stages and commits via this repo on every flush. When unset, marky only writes files to disk. |
| `MARKY_GIT_AUTHOR_NAME` | git | no | Commit author name. Default `marky-bot`. |
| `MARKY_GIT_AUTHOR_EMAIL` | git | no | Commit author email. Default `marky-bot@<MARKY_BASE_URL host>` or `marky-bot@localhost`. |
| `MARKY_GIT_PUSH` | git | no | `true` to enable periodic push. Requires `MARKY_GIT_PAT`. Default off. |
| `MARKY_GIT_PAT` | git | when `MARKY_GIT_PUSH=true` | GitHub PAT used for push auth. Never written to disk. |
| `MARKY_PERSIST_IDLE_MS` | both | no | Per-file debounce window in ms. Default 60000. |
| `MARKY_PUSH_INTERVAL_MS` | git | no | Periodic push frequency in ms. Default 300000. 0 disables. |
| `DISCORD_BOT_TOKEN` | discord | no | Enables true role color resolution |

In discord mode, missing required env vars cause the server to exit with a
list of what's missing before binding the port.

A commented `.env.example` lives at the repo root. Copy it to `.env` for
local development:

```sh
cp .env.example .env
```

`.env` is gitignored.

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

## Persistence

Marky debounces edits per-file. After `MARKY_PERSIST_IDLE_MS` of no edits
(default 60s), the file is written to disk. When `MARKY_GIT_REPO` is set,
the write is followed by `git add` + `git commit` in that repo, authored
as `marky-bot`. The commit message records which editors touched the file
during the debounce window:

```
edit Jack.md — jackharrhy
edit Notes.md — alex, jackharrhy, tim
rename Jack.md → Jack-Arthur.md — jackharrhy
delete Old.md — alex
```

When `MARKY_GIT_PUSH=true` and `MARKY_GIT_PAT` is set, marky also pushes
HEAD to origin every `MARKY_PUSH_INTERVAL_MS` (default 5 minutes) using
the PAT to authenticate over HTTPS.

If `MARKY_GIT_REPO` is unset, edits still persist to disk; commits and
pushes are skipped.

Rename and delete are available via right-click on files in the sidebar.
Rename uses an inline input; delete asks for confirmation via the
browser.

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
test/                           remix/test suites
server.ts                       boots Remix + attaches WebSocket
```
