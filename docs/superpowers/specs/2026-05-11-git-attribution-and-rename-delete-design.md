# Git-attributed auto-persist + file rename/delete

## Goal

Replace the manual "Persist" button with a per-file 60-second idle auto-save
that writes to disk and, when a git repo is mounted, commits the change to
that repo with a message recording which editors touched the file.

Add file rename and delete operations to the editor, routed through the same
debounced commit pipeline so renames and deletes appear in git history too.

In production the editor's content directory is a subdirectory of an
existing git repo (`compsci-bois-almanac`); commits land in that repo as
`marky-bot` with the message body carrying the Discord usernames of the
actual editors. A periodic push job sends accumulated commits to GitHub.

## Non-goals

- File moves into subdirectories. All files stay flat in `content/`.
- Bulk multi-file operations (multi-select rename/delete).
- Merge conflict resolution. Marky is a naive owner of the working tree;
  if origin moves under it, the periodic push fails and the operator
  reconciles manually.
- Soft-delete / trash. Deleted files are gone from the working tree;
  recovery is via `git checkout HEAD~ -- <path>`.
- Commit attribution via real git author / committer fields or
  `Co-authored-by:` trailers. Every commit is authored by `marky-bot`;
  attribution lives in the commit message text only.
- File creation as a distinct operation. Files are created today by typing
  a name in the sidebar and opening it (the server creates the empty file
  on the first `OPEN_FILE`); that flow is unchanged.

## Configuration

| Var | Mode | Required | Description |
| --- | --- | --- | --- |
| `MARKY_GIT_REPO` | both | no | Absolute path to a git repo. When set, marky stages and commits via this repo. When unset, marky writes files but never invokes git. |
| `MARKY_GIT_AUTHOR_NAME` | git | no | Commit author name. Default `marky-bot`. |
| `MARKY_GIT_AUTHOR_EMAIL` | git | no | Commit author email. Default `marky-bot@<host of MARKY_BASE_URL>`. |
| `MARKY_GIT_PUSH` | git | no | `true` to enable periodic `git push`. Default `false`. |
| `MARKY_GIT_PAT` | git | when `MARKY_GIT_PUSH=true` | GitHub personal access token. Used per-push to rewrite the origin URL to `https://x-access-token:<pat>@github.com/...`. Never written to disk. |
| `MARKY_PERSIST_IDLE_MS` | both | no | Per-file debounce window. Default 60_000. |
| `MARKY_PUSH_INTERVAL_MS` | git | no | Periodic push frequency. Default 300_000 (5 min). 0 disables the push timer. |

In production these get rendered from
`infra/hosts/newport/secrets/marky.enc.yaml`. The `MARKY_GIT_PAT` is the
only secret; the others are inline `environment` in `compose.yml`.

## Architecture

### File layout

```
app/
  config.ts                            extended with optional `git` config
  data/
    content-store.ts                   (existing) gains rename/delete methods
    git-store.ts                       new; simple-git wrapper
    discord.ts                         (existing)
  middleware/
    sockets.ts                         SocketRoom gains pending-ops + debounce
    auth.ts                            (existing)
  shared/
    message-types.ts                   adds RENAME_FILE, DELETE_FILE, ERROR;
                                       PERSIST_FILE entry removed
    constants.ts                       PERSIST_BUTTON_RESET_DELAY_MS removed
  frontend/
    socket-handler.ts                  renameFile, deleteFile, onError
  ui/
    editor/
      editor-app.tsx                   context menu + rename mode + toast
```

`app/data/git-store.ts` is new. `app/middleware/sockets.ts` and
`app/ui/editor/editor-app.tsx` get the most invasive changes.

### Config module changes (`app/config.ts`)

```ts
export interface GitConfig {
  repoDir: string
  authorName: string
  authorEmail: string
  persistIdleMs: number       // default 60_000
  pushIntervalMs: number      // default 300_000; 0 disables
  push?: { pat: string }      // present iff MARKY_GIT_PUSH=true
}

export interface AppConfig {
  auth: AuthConfig
  port: number
  contentDir: string
  git?: GitConfig             // undefined when MARKY_GIT_REPO is unset
}
```

Validation rules added to `loadConfig`:

- `MARKY_GIT_REPO` set → `git` is populated.
  - `authorName` defaults to `marky-bot`.
  - `authorEmail` defaults to `marky-bot@<MARKY_BASE_URL host>`. If
    `MARKY_BASE_URL` is unset, defaults to `marky-bot@localhost`.
  - `persistIdleMs` and `pushIntervalMs` parse like `PORT`: integer or
    fail-fast.
- `MARKY_GIT_PUSH=true` with no `MARKY_GIT_PAT` → fail-fast with a clear
  error.
- `MARKY_GIT_PAT` set but `MARKY_GIT_REPO` unset → fail-fast (config
  inconsistency).

### `GitStore` (`app/data/git-store.ts`)

`simple-git`-based wrapper. Idempotent and side-effect-free aside from the
explicit operations.

```ts
import { simpleGit, type SimpleGit } from 'simple-git'

export interface GitStoreOptions {
  repoDir: string
  authorName: string
  authorEmail: string
  push?: { pat: string }
}

export class GitStore {
  private readonly git: SimpleGit
  private readonly repoDir: string
  private readonly authorName: string
  private readonly authorEmail: string
  private readonly pushPat?: string

  constructor(opts: GitStoreOptions) {
    this.git = simpleGit(opts.repoDir)
    this.repoDir = opts.repoDir
    this.authorName = opts.authorName
    this.authorEmail = opts.authorEmail
    this.pushPat = opts.push?.pat
  }

  /** Verify the repo dir is a git working tree. Throws if not. */
  async assertRepo(): Promise<void>

  /** Stage an existing file (created or modified). Relative path. */
  stageEdit(args: { path: string }): Promise<void>     // git add -- <path>

  /** Stage a rename on the index. Both paths are relative to repoDir. */
  stageRename(args: { oldPath: string; newPath: string }): Promise<void>
  // git mv <oldPath> <newPath>

  /** Stage a deletion. Relative path. */
  stageDelete(args: { path: string }): Promise<void>   // git rm <path>

  /**
   * Commit currently-staged changes. Returns null if nothing is staged
   * (idempotent).
   */
  commit(message: string): Promise<{ sha: string } | null>

  /** True when HEAD is ahead of @{u}. */
  hasUnpushed(): Promise<boolean>

  /** Push HEAD to origin. PAT, if set, is injected into the URL per-call. */
  push(): Promise<void>
}
```

Notes:

- `commit` invokes `git -c user.name=... -c user.email=... commit -m '...'`
  using `simple-git`'s `env` and `customConfig` options so the repo's
  existing `.git/config` is never modified.
- The author and committer timestamp are the wall clock at commit time;
  no historical-time tricks.
- `push` reads `git remote get-url origin`, injects
  `https://x-access-token:<pat>@github.com/...` for the duration of the
  call (`simple-git`'s `push` accepts a custom URL), and never writes
  back. If the remote isn't `github.com`-style HTTPS, push falls back to
  the plain `git push` and trusts SSH/credentials.
- `assertRepo` runs at boot once; later operations don't re-check.

### `ContentStore` (`app/data/content-store.ts`)

Gains two methods on the existing class. Filename validation already
prevents traversal:

```ts
rename(args: { oldName: string; newName: string }): Promise<void>
// Asserts both filenames safe. Throws if newName already exists.
// Performs fs.rename within `this.dir`.

remove(filename: string): Promise<void>
// Asserts filename safe. fs.unlink. ENOENT is swallowed (no-op when the
// file is already gone).
```

`ContentStore` knows only about its content directory. It does NOT call
git. The orchestration (write/rename/remove on disk, then stage in git,
then commit later) lives in `SocketRoom`.

### Wire protocol additions (`app/shared/message-types.ts`)

```
MESSAGE_TYPE_SYNC               = 0   (existing)
MESSAGE_TYPE_AWARENESS          = 1   (existing)
MESSAGE_TYPE_FILE_LIST          = 2   (existing)
MESSAGE_TYPE_OPEN_FILE          = 3   (existing)
MESSAGE_TYPE_PERSIST_FILE       = 4   REMOVED
MESSAGE_TYPE_SUBDOC_SYNC        = 5   (existing)
MESSAGE_TYPE_SUBDOC_AWARENESS   = 6   (existing)
MESSAGE_TYPE_RENAME_FILE        = 7   NEW
MESSAGE_TYPE_DELETE_FILE        = 8   NEW
MESSAGE_TYPE_ERROR              = 9   NEW
```

- `PERSIST_FILE` is deleted in the same commit on both sides. The numeric
  slot stays unused; we do NOT recycle `4`.
- Renaming on the wire: `[7, oldLen, ...oldName, ...newName]`. The `newName`
  occupies the rest of the frame (server reads `oldLen`, slices, then
  treats the remainder as `newName`). This matches the existing
  filename-length-prefix idiom (`encodeFileMessage`); see the new helper
  below.
- Deleting: `[8, ...name]`.
- Error frame: `[9, ...utf-8 message]`. Server-only direction; client
  decodes and surfaces as a toast. Used for rename collisions and any
  future server-side rejection of a client request.

Two new helpers in `app/shared/wire.ts`:

```ts
encodeRenameFrame(oldName: string, newName: string): Uint8Array
decodeRenameFrame(content: Uint8Array): { oldName: string; newName: string }
```

These wrap the same length-prefix logic as `encodeFileMessage` /
`decodeFileMessage`. Tests cover round-tripping a pair where `oldName`
contains the maximum length (255 bytes).

### `SocketRoom` changes (`app/middleware/sockets.ts`)

#### Pending-ops + debounce timers

```ts
interface PendingOp {
  kind: 'edit' | 'rename' | 'delete'
  editors: Set<string>
  oldName?: string         // when kind === 'rename'
}

private readonly pendingOps = new Map<string, PendingOp>()
private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
```

The map is keyed by the *current* filename of the operation. On rename,
the key migrates: `pendingOps.delete(oldName); pendingOps.set(newName, ...)`.

#### Edit path

In the existing `MESSAGE_TYPE_SUBDOC_SYNC` branch, after applying the
update to the subdoc:

```ts
this.recordPending(filename, peer, { kind: 'edit' })
```

`recordPending(filename, peer, op)`:

1. Resolve the editor's display name: `peers.get(peer)?.identity?.name`
   if present (discord mode); else the most recent `user.name` on the
   subdoc awareness for that peer's clientID (anonymous mode); else
   `'unknown'`.
2. Get or initialize `pendingOps.get(filename)`. Merge by precedence
   (see below).
3. Clear and re-arm the file's `flushTimers` entry with
   `setTimeout(() => this.flush(filename), config.git?.persistIdleMs ?? 60_000)`.

Merge precedence when a new op stacks on a pending op:

| Existing | Incoming | Result |
| --- | --- | --- |
| `edit` | `edit` | `edit`, editors union |
| `edit` | `rename` | `rename`, editors union, oldName from incoming |
| `edit` | `delete` | `delete`, editors union |
| `rename` | `edit` | `rename`, editors union, oldName preserved from existing |
| `rename` | `rename` | `rename`, editors union, **oldName preserved from existing** (so A → B → C becomes `rename A.md → C.md`) |
| `rename` | `delete` | `delete`, editors union (rename effectively undone) |
| `delete` | anything | stays `delete`, editors union |

The recordPending step must check `existing.oldName` before assigning;
incoming `oldName` is only used when no rename is pending yet.

Stacking happens by key migration on rename; subsequent edits hit the new
key and merge naturally.

#### Rename branch

New `MESSAGE_TYPE_RENAME_FILE` case in `receive`:

1. Decode `{ oldName, newName }`.
2. `assertSafeFilename(newName)` (and `oldName`); on invalid, send
   `MESSAGE_TYPE_ERROR`.
3. If `filenameToSubdoc.has(newName)`: send `MESSAGE_TYPE_ERROR` with body
   `Cannot rename: <newName> already exists.` to the requesting peer.
   Don't touch state.
4. `store.rename({ oldName, newName })` (handles disk).
5. Rebind in-memory:
   - `filesMap.delete(oldName); filesMap.set(newName, subdoc)`
   - migrate `filenameToSubdoc`, `filenameToSubdocAwareness`,
     `subdocBroadcastHandlers`, and per-peer `subscriptions` set keys
   - migrate `pendingOps` and `flushTimers` entries with key change
   - the existing broadcaster handler closes over the old filename; the
     simplest fix is `ensureSubdocBroadcaster(newName, subdoc)` (after
     deleting the old handler entry) so subsequent updates broadcast with
     the new filename
6. `recordPending(newName, peer, { kind: 'rename', oldName })` (this
   schedules / re-arms the flush timer).
7. Broadcast `MESSAGE_TYPE_FILE_LIST` to every connected peer.
8. Stage in git on flush, not here.

#### Delete branch

New `MESSAGE_TYPE_DELETE_FILE` case:

1. Decode `name`. Validate.
2. If unknown to the room (already deleted), no-op.
3. Destroy the subdoc; delete all room-level entries keyed by `name`
   (subdoc map, awareness, broadcaster, per-peer subscriptions).
4. `store.remove(name)`.
5. `recordPending(name, peer, { kind: 'delete' })`. The flush will fire
   `stageDelete` instead of writing the file back.
6. Broadcast `MESSAGE_TYPE_FILE_LIST`.

#### Flush

`flush(filename)`:

1. `op = pendingOps.get(filename)`. If no op, return.
2. `pendingOps.delete(filename); flushTimers.delete(filename)`.
3. If `op.kind === 'delete'`:
   - file is already off disk and out of the room from the receive
     handler.
   - if `gitStore`: `gitStore.stageDelete({ path: relPath(filename) })`,
     then commit with `delete <filename> — <editors>`.
4. If `op.kind === 'rename'`:
   - `op.oldName` is set; the file already moved on disk via
     `store.rename` at receive time.
   - Write the subdoc to disk under `filename` (the new name) via
     `persistSubdocToDisk(filename, subdoc)` so any unflushed edits land
     with the rename.
   - if `gitStore`: `stageRename({ oldPath: relPath(op.oldName), newPath: relPath(filename) })`
     then `stageEdit({ path: relPath(filename) })` (so body changes ride
     along), then commit `rename <oldName> → <newName> — <editors>`. The
     message stays a rename even when body changes are included; the
     diff carries the body.
5. If `op.kind === 'edit'`:
   - Write the subdoc to disk via existing `persistSubdocToDisk(filename, subdoc)`.
   - if `gitStore`: `stageEdit({ path: relPath(filename) })`, then commit
     `edit <filename> — <editors>`.
6. Editors set is joined `, ` after sorting alphabetically.
7. Catch and log per-step errors. Failures don't crash the room. A failed
   git step leaves the file on disk; next edit's flush will pick it up.

`relPath(filename)` = filename relative to `git.repoDir`. If
`config.contentDir` starts with `git.repoDir + '/'`, the relative path is
`<contentDir suffix>/<filename>` (e.g. `content/Jack.md`). Otherwise
fail-fast at boot (the operator misconfigured something).

#### Periodic push

`attachSockets` schedules an interval when `config.git?.pushIntervalMs > 0`
and `config.git?.push` is set:

```ts
const pushTimer = setInterval(async () => {
  try {
    if (await gitStore.hasUnpushed()) await gitStore.push()
  } catch (error) {
    console.error('marky: git push failed', error)
  }
}, config.git.pushIntervalMs)
```

The timer is cleared on server shutdown.

### Client-side editor changes (`app/ui/editor/editor-app.tsx`)

#### Context menu

A new piece of EditorApp state:

```ts
let contextMenu: { filename: string; x: number; y: number } | null = null
let renamingFilename: string | null = null
let renameInput: HTMLInputElement | null = null
let toast: { text: string; timeoutId: number | null } | null = null
```

Each `<li>` in the file list gets `oncontextmenu` (prevents default) which
sets `contextMenu = { filename, x, y }` and re-renders.

The menu is a small `<div>` positioned at `(x, y)` with two buttons:
**Rename** and **Delete**. Outside-click (a global `mousedown` listener
attached via `handle.signal`) closes the menu.

#### Rename mode

Clicking **Rename** in the context menu:
1. Closes the menu.
2. Sets `renamingFilename = filename`.
3. The `<li>` for that filename, on next render, shows an `<input>`
   pre-filled with `filename.replace(/\.md$/, '')` instead of static text.
4. Input gets `autoFocus`. Enter submits; Escape cancels (clears
   `renamingFilename`).
5. On submit: validate not empty, append `.md` if missing. If unchanged,
   no-op. Otherwise `socket.renameFile(oldName, newName)`. Clear
   `renamingFilename`.

#### Delete

Clicking **Delete** in the context menu:
1. Closes the menu.
2. `window.confirm("Delete " + filename + "?")` — if yes,
   `socket.deleteFile(filename)`.
3. Server responds with a new `MESSAGE_TYPE_FILE_LIST`; the local file
   list updates and the editor mount switches to the empty-state if it
   was open.

#### Toast

When `MESSAGE_TYPE_ERROR` arrives from the server, the `onError(msg)`
callback fires. EditorApp stores it in `toast`, schedules a 4s clear, and
re-renders. The toast is a small fixed-position `<div>` bottom-right.

`MESSAGE_TYPE_ERROR` is the only path for server-initiated user-facing
errors today; the design leaves room for future cases (e.g. quota
exceeded, save failed) without further wire format change.

#### Persist button removal

The existing **Persist** button JSX, the `persistLabel` state, and the
`persistResetTimer` cleanup are all deleted. The `MESSAGE_TYPE_PERSIST_FILE`
wire constant is removed in the same commit; both server and browser stop
referring to it.

### `SocketHandler` browser-side additions (`app/frontend/socket-handler.ts`)

New methods:

```ts
renameFile(oldName: string, newName: string): void
// sends MESSAGE_TYPE_RENAME_FILE via encodeRenameFrame

deleteFile(name: string): void
// sends MESSAGE_TYPE_DELETE_FILE

close()  // already exists
```

New callback in `SocketHandlerCallbacks`:

```ts
onError?: (message: string) => void
```

In `handleMessage`, a new branch for `MESSAGE_TYPE_ERROR` decodes the body
as UTF-8 and calls `callbacks.onError?.(body)`.

Existing `persistFile` method is removed along with `MESSAGE_TYPE_PERSIST_FILE`.

## Boot wiring (`server.ts`)

```
1. loadConfig() (as today)
2. ContentStore (as today)
3. if config.git:
     gitStore = new GitStore({ ... })
     await gitStore.assertRepo()
4. createRouter(...)
5. attachSockets(server.app, { store, gitStore, config, sessionStorage, sessionCookie })
6. server starts; push timer arms if applicable
```

If `gitStore.assertRepo()` throws, boot fails before binding the port.

`attachSockets` now takes a `gitStore?: GitStore` field; in anonymous-mode
deployments the field is absent and the room writes files but skips git.
Discord mode is unchanged from a wiring standpoint — git is an
independent axis.

## Failure modes

| Failure | Response |
| --- | --- |
| `MARKY_GIT_REPO` set but not a git working tree | Boot exits with `marky: <path> is not a git repository` |
| `MARKY_GIT_PUSH=true` with no PAT | Boot exits with config validation error |
| File write fails on flush | Log; drop the timer; preserve pending op so next attempt covers everything |
| `git add` fails | Log; drop this flush; preserve nothing (next edit re-arms) |
| `git commit` says "nothing to commit" | Treat as success; clear pending op |
| `git push` fails (non-fast-forward, auth) | Log; next push interval retries; no automatic fetch |
| Rename collision (newName exists) | Server sends `MESSAGE_TYPE_ERROR` to requester; state unchanged |
| Rename source missing | Send `MESSAGE_TYPE_ERROR`; state unchanged |
| Delete of unknown file | No-op, no error |
| Invalid filename (path traversal, bad ext) | Server sends `MESSAGE_TYPE_ERROR` |

## Testing

### `git-store.test.ts` (new)

Runs against a temp dir initialized with `git init` and a single seed
commit, no remote. Covers:

- `stageEdit` then `commit` produces a new HEAD with the right message
  and a single-author commit (`marky-bot`)
- `commit` returns `null` when nothing is staged
- `stageRename` produces a single rename in the next commit
  (`git diff-tree --name-status -r HEAD` shows `R100`)
- `stageDelete` produces a deletion
- `hasUnpushed` returns true after a commit on a branch with no upstream
  (treats no-upstream as "unpushed")
- The repo's `.git/config` is untouched after commits (config flags are
  per-call only)
- `push` against a missing remote fails loudly without retrying

`simple-git` is a real dependency; tests use it directly against a real
on-disk repo, no mocking.

### `wire.test.ts` (extensions)

- `encodeRenameFrame` / `decodeRenameFrame` round-trip
- Reject `oldName` > 255 bytes (matches `encodeFileMessage`'s constraint)

### `socket-room.test.ts` (extensions)

`FakePeer` + fake-timer based tests for:

- A single peer edits a file; after 60s the room calls `gitStore.commit`
  with `edit <name> — <editor>`
- Two peers edit the same file within 60s; commit message lists both
  editors alphabetically
- A peer edits A.md then B.md; two independent timers, two independent
  commits
- Rename A.md → B.md schedules a commit `rename A.md → B.md — <editor>`;
  in-memory state is migrated
- Rename collision: server emits `MESSAGE_TYPE_ERROR`; no state change
- Delete schedules a commit `delete <name> — <editor>`
- Edit-then-rename collapses to one rename commit naming both
  filenames
- Rename-then-delete collapses to one delete commit
- When `gitStore` is absent, the disk write still happens and no commit
  is attempted

`gitStore` is replaced with a `FakeGitStore` that records calls (no real
git in this layer's tests).

### `content-store.test.ts` (extensions)

- `rename` moves the file on disk
- `rename` throws when `newName` already exists
- `rename` rejects unsafe names
- `remove` deletes
- `remove` rejects unsafe names
- `remove` on a missing file is a no-op (ENOENT swallowed)

### `auth.test.ts` / `routes.test.ts` (no changes)

The auth flow and router tests are unaffected; this feature is orthogonal
to auth.

## Documentation changes

`AGENTS.md` gains a new section after "Auth Modes":

```
## Persistence and Git

Edits to a file debounce for `MARKY_PERSIST_IDLE_MS` (default 60s) before
being flushed to disk. When `MARKY_GIT_REPO` is set, the flush also runs
`git add`/`git mv`/`git rm` + `git commit` in that repo, authored as
`marky-bot` with a message that records the Discord usernames of the
editors who touched the file during the debounce window. A separate
interval (`MARKY_PUSH_INTERVAL_MS`, default 5 min) pushes accumulated
commits via HTTPS using `MARKY_GIT_PAT` when push is enabled.

`SocketRoom` tracks pending operations per-filename with merge semantics:
edit + rename + edit collapses to a single rename commit; rename + delete
collapses to a single delete commit.
```

`README.md` env table gains rows for the new `MARKY_GIT_*` vars and
`MARKY_PERSIST_IDLE_MS` / `MARKY_PUSH_INTERVAL_MS`. The "Auth modes"
section gets a note that git attribution + Discord auth produces the
richest history; anonymous mode commits use the random palette name.

`.env.example` gains the new vars (commented out by default).

## Out of scope (explicitly)

- File moves into subdirectories
- Bulk operations
- Trash / soft-delete
- Merge conflict resolution / `pull --rebase` machinery
- Tracking which lines each editor changed (line-level blame would
  require a separate diff-attribution layer; we record file-level
  authorship only)
- Real git Author / committer attribution (multi-author commits would
  need email addresses we don't have for Discord users; the message-text
  approach sidesteps that)
- A force-flush admin endpoint (could come later if needed)
