# Editor UI for file ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the manual Persist button. Add a right-click context menu (Rename / Delete) on each file in the sidebar. Rename swaps the file entry for an inline input. Delete uses a `window.confirm`. A toast appears when the server sends `MESSAGE_TYPE_ERROR`. After this plan the editor is fully auto-persisted and supports per-file rename/delete with attributed git commits behind it.

**Architecture:** New EditorApp state (`contextMenu`, `renamingFilename`, `toast`) plus a global `mousedown` listener that closes the menu. `SocketHandler` gains `renameFile`, `deleteFile`, and an `onError` callback. The Persist button JSX, `persistLabel`, and `persistResetTimer` are deleted along with the `PERSIST_BUTTON_RESET_DELAY_MS` shared constant.

**Tech Stack:** Remix UI (`clientEntry`, `css`, `on`, `ref`, `Handle`), existing browser-side `SocketHandler`, `MESSAGE_TYPE_ERROR` from the wire helpers.

**Reference:** `docs/superpowers/specs/2026-05-11-git-attribution-and-rename-delete-design.md` — sections "Client-side editor changes", "`SocketHandler` browser-side additions".

**Prerequisite:** Plan 2 is merged. Server already handles rename/delete frames and emits ERROR frames; the browser doesn't yet call them or display them.

---

## File Structure

- Modify: `app/frontend/socket-handler.ts` — `renameFile`, `deleteFile`, `onError` plumbing
- Modify: `app/ui/editor/editor-app.tsx` — context menu, rename mode, toast, persist removal
- Modify: `app/shared/constants.ts` — remove `PERSIST_BUTTON_RESET_DELAY_MS`
- Modify: `test/socket-room.test.ts` — none (covered in Plan 2)
- No new test files; the UI behaviors are exercised manually because the codebase has no component test harness yet

---

### Task 1: `SocketHandler` — rename/delete/onError plumbing

**Files:**
- Modify: `app/frontend/socket-handler.ts`

- [ ] **Step 1: Read the current file**

```sh
cat app/frontend/socket-handler.ts
```

The file already imports message-type constants. Plan 2 already removed the `MESSAGE_TYPE_PERSIST_FILE` import and the `persistFile` method.

- [ ] **Step 2: Add imports for the new message types**

At the top of the file, extend the message-types import to include the three new ones:

```ts
import {
  MESSAGE_TYPE_AWARENESS,
  MESSAGE_TYPE_DELETE_FILE,
  MESSAGE_TYPE_ERROR,
  MESSAGE_TYPE_FILE_LIST,
  MESSAGE_TYPE_OPEN_FILE,
  MESSAGE_TYPE_RENAME_FILE,
  MESSAGE_TYPE_SUBDOC_AWARENESS,
  MESSAGE_TYPE_SUBDOC_SYNC,
  MESSAGE_TYPE_SYNC,
} from '../shared/message-types.ts'
```

Extend the wire import with `encodeRenameFrame`:

```ts
import {
  decodeFileMessage,
  decodeUtf8,
  encodeFileMessage,
  encodeMessage,
  encodeRenameFrame,
  encodeUtf8,
  toUint8,
} from '../shared/wire.ts'
```

- [ ] **Step 3: Add the `onError` callback to the callbacks interface**

Find `SocketHandlerCallbacks` and append:

```ts
export interface SocketHandlerCallbacks {
  onFileListUpdate: (files: string[]) => void
  onSubdocUpdate: (filename: string, subdoc: Y.Doc) => void
  onAwarenessUpdate?: () => void
  onSubdocAwarenessUpdate?: (filename: string) => void
  onError?: (message: string) => void
}
```

- [ ] **Step 4: Handle `MESSAGE_TYPE_ERROR` frames in `handleMessage`**

Find `handleMessage` and add a branch (place it after the existing `MESSAGE_TYPE_FILE_LIST` branch):

```ts
    if (messageType === MESSAGE_TYPE_ERROR) {
      const text = decodeUtf8(content)
      this.callbacks.onError?.(text)
      return
    }
```

- [ ] **Step 5: Add `renameFile` and `deleteFile` methods**

Add to the class (place near the existing `openFile` method):

```ts
  renameFile(oldName: string, newName: string): void {
    this.send(encodeRenameFrame(oldName, newName))
  }

  deleteFile(filename: string): void {
    this.send(encodeMessage(MESSAGE_TYPE_DELETE_FILE, encodeUtf8(filename)))
  }
```

- [ ] **Step 6: Run typecheck + tests**

```sh
npm run typecheck
npm test
```

Expected: typecheck clean; existing tests pass (no new tests at this layer — UI is exercised manually).

- [ ] **Step 7: Commit**

```sh
git add app/frontend/socket-handler.ts
git commit -m "socket-handler: add renameFile, deleteFile, onError"
```

---

### Task 2: Remove `PERSIST_BUTTON_RESET_DELAY_MS`

**Files:**
- Modify: `app/shared/constants.ts`

- [ ] **Step 1: Edit the file**

Read it first:

```sh
cat app/shared/constants.ts
```

Remove the `PERSIST_BUTTON_RESET_DELAY_MS` export entirely.

- [ ] **Step 2: Confirm no consumers remain**

```sh
grep -rn PERSIST_BUTTON_RESET_DELAY_MS app/ test/
```

Expected: matches in `app/ui/editor/editor-app.tsx` only (still imports it). Task 3 removes that import as part of the persist-button removal. Leave typecheck broken until then; commit + continue.

If `grep` returns matches outside `editor-app.tsx`, stop and report — there's an extra consumer that wasn't anticipated.

- [ ] **Step 3: Run typecheck**

```sh
npm run typecheck
```

Expected: error in `app/ui/editor/editor-app.tsx` for the missing import. That gets cleaned up next task.

- [ ] **Step 4: Commit**

```sh
git add app/shared/constants.ts
git commit -m "constants: remove PERSIST_BUTTON_RESET_DELAY_MS"
```

---

### Task 3: EditorApp — remove the Persist button + state

**Files:**
- Modify: `app/ui/editor/editor-app.tsx`

- [ ] **Step 1: Remove the import**

At the top, the import line currently is:

```ts
import { MARKDOWN_EXTENSION, PERSIST_BUTTON_RESET_DELAY_MS } from '../../shared/constants.ts'
```

Change to:

```ts
import { MARKDOWN_EXTENSION } from '../../shared/constants.ts'
```

- [ ] **Step 2: Remove `persistLabel` and `persistResetTimer` state**

Find these lines near the top of the setup phase:

```ts
let persistLabel = 'Persist'
let persistResetTimer: ReturnType<typeof setTimeout> | null = null
```

Delete both.

- [ ] **Step 3: Remove the `persist()` function and any references**

Search for `function persist` and delete the whole function. Also remove the `persistResetTimer` cleanup line in the existing `handle.signal.addEventListener('abort', ...)` block (the line `if (persistResetTimer) clearTimeout(persistResetTimer)` — delete just that one line).

- [ ] **Step 4: Remove the Persist button JSX**

Find the JSX that renders the Persist button. It looks roughly like:

```tsx
<button mix={[buttonStyle, on('click', persist)]}>{persistLabel}</button>
```

Delete the entire `<button>` element. If it lives inside a wrapper `<div>` whose only child is now empty, delete the wrapper too.

- [ ] **Step 5: Run typecheck**

```sh
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Smoke-render the page locally**

```sh
PORT=44920 npx tsx server.ts &
sleep 3
curl -s http://localhost:44920/ | grep -c "Persist" || echo "(no Persist text found, as expected)"
kill %1 2>/dev/null
```

Expected: `(no Persist text found, as expected)` (the count is 0; `grep -c` exit 1 → fallback message). If you see a positive count, you missed a reference.

- [ ] **Step 7: Run full tests**

```sh
npm test
```

Expected: still passing.

- [ ] **Step 8: Commit**

```sh
git add app/ui/editor/editor-app.tsx
git commit -m "editor: remove the manual Persist button"
```

---

### Task 4: Context menu state + open/close behavior

**Files:**
- Modify: `app/ui/editor/editor-app.tsx`

- [ ] **Step 1: Add new state variables**

In the setup phase, add (near `let awarenessStates = ...`):

```ts
let contextMenu: { filename: string; x: number; y: number } | null = null
let renamingFilename: string | null = null
let renameInput: HTMLInputElement | null = null
let toast: { text: string; expiresAt: number } | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null
```

- [ ] **Step 2: Add helpers near the other helpers**

```ts
    function closeContextMenu(): void {
      if (contextMenu === null) return
      contextMenu = null
      refresh()
    }

    function openContextMenuFor(filename: string, x: number, y: number): void {
      contextMenu = { filename, x, y }
      refresh()
    }

    function showToast(text: string): void {
      toast = { text, expiresAt: Date.now() + 4000 }
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        toast = null
        toastTimer = null
        refresh()
      }, 4000)
      refresh()
    }
```

- [ ] **Step 3: Attach the `onError` callback to `SocketHandler`**

Find the `socket = new SocketHandler({ ... })` block in the setup phase. Add `onError: showToast` to the callbacks object:

```ts
    socket = new SocketHandler({
      onFileListUpdate: (next) => { /* ...existing... */ },
      onSubdocUpdate: (filename) => { /* ...existing... */ },
      onAwarenessUpdate: () => { /* ...existing... */ },
      onSubdocAwarenessUpdate: (filename) => { /* ...existing... */ },
      onError: showToast,
    })
```

- [ ] **Step 4: Add a global mousedown listener that closes the menu**

Near where `handle.signal.addEventListener('abort', ...)` lives (or just add a new block in the setup phase, gated on `isBrowser`):

```ts
    if (isBrowser) {
      const onGlobalMouseDown = () => closeContextMenu()
      window.addEventListener('mousedown', onGlobalMouseDown)
      handle.signal.addEventListener('abort', () => {
        window.removeEventListener('mousedown', onGlobalMouseDown)
        if (toastTimer) clearTimeout(toastTimer)
      })
    }
```

Don't close on mousedown that originated from the menu itself — the menu's own buttons need their clicks to register. We handle that by setting `event.stopPropagation()` on the menu's `mousedown` (see Task 5).

- [ ] **Step 5: Run typecheck**

```sh
npm run typecheck
```

Expected: clean (no UI rendering changes yet — the menu/toast aren't drawn).

- [ ] **Step 6: Commit**

```sh
git add app/ui/editor/editor-app.tsx
git commit -m "editor: add context menu and toast state + onError plumbing"
```

---

### Task 5: Context menu rendering + rename mode JSX

**Files:**
- Modify: `app/ui/editor/editor-app.tsx`

- [ ] **Step 1: Find the file-list `<li>` JSX**

Locate the render function's file-list section. The current pattern looks roughly like:

```tsx
files.map((filename) => (
  <li
    key={filename}
    mix={[fileItemStyle, on('click', () => openFile(filename))]}
  >
    <span>{filename.replace(/\.md$/, '')}</span>
    {/* presence dots */}
  </li>
))
```

Replace with:

```tsx
files.map((filename) => {
  const isRenaming = renamingFilename === filename
  return (
    <li
      key={filename}
      mix={[
        fileItemStyle,
        on('click', () => {
          if (!isRenaming) openFile(filename)
        }),
        on('contextmenu', (event) => {
          event.preventDefault()
          openContextMenuFor(filename, event.clientX, event.clientY)
        }),
      ]}
    >
      {isRenaming ? (
        <input
          type="text"
          defaultValue={filename.replace(/\.md$/, '')}
          mix={[
            renameInputStyle,
            ref<HTMLInputElement>((node) => {
              renameInput = node
              node.focus()
              node.select()
            }),
            on('keydown', (event) => {
              const key = (event as KeyboardEvent).key
              if (key === 'Enter') {
                event.preventDefault()
                submitRename(filename)
              } else if (key === 'Escape') {
                event.preventDefault()
                renamingFilename = null
                refresh()
              }
            }),
            on('mousedown', (event) => event.stopPropagation()),
            on('click', (event) => event.stopPropagation()),
          ]}
        />
      ) : (
        <span>{filename.replace(/\.md$/, '')}</span>
      )}
      {/* presence dots (preserve the existing JSX block that renders viewer dots) */}
    </li>
  )
})
```

Make sure the existing presence-dots JSX (the small avatar circles) is preserved inside the `<li>` after the input/span ternary.

- [ ] **Step 2: Add `submitRename` helper**

Near `openFile` / `createFile`:

```ts
    function submitRename(oldName: string): void {
      if (!socket || !renameInput) return
      const raw = renameInput.value.trim()
      if (!raw) {
        renamingFilename = null
        refresh()
        return
      }
      const newName = raw.endsWith(MARKDOWN_EXTENSION) ? raw : `${raw}${MARKDOWN_EXTENSION}`
      if (newName === oldName) {
        renamingFilename = null
        refresh()
        return
      }
      socket.renameFile(oldName, newName)
      if (currentFilename === oldName) currentFilename = newName
      renamingFilename = null
      refresh()
    }
```

- [ ] **Step 3: Render the context menu**

After the file-list `<ul>` (or near the end of the JSX, before the toast):

```tsx
{contextMenu && (
  <div
    mix={[
      contextMenuStyle,
      on('mousedown', (event) => event.stopPropagation()),
    ]}
    style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
  >
    <button
      type="button"
      mix={[contextMenuItemStyle, on('click', () => {
        if (!contextMenu) return
        renamingFilename = contextMenu.filename
        closeContextMenu()
      })]}
    >
      Rename
    </button>
    <button
      type="button"
      mix={[contextMenuItemStyle, on('click', () => {
        if (!contextMenu || !socket) return
        const target = contextMenu.filename
        closeContextMenu()
        if (window.confirm(`Delete ${target}?`)) {
          socket.deleteFile(target)
          if (currentFilename === target) {
            currentFilename = null
            editorMountedFor = null
          }
          refresh()
        }
      })]}
    >
      Delete
    </button>
  </div>
)}
```

- [ ] **Step 4: Render the toast**

Just before the closing tag of the root div:

```tsx
{toast && <div mix={toastStyle}>{toast.text}</div>}
```

- [ ] **Step 5: Add the style blocks**

Near the existing style definitions at the bottom of the file:

```ts
const contextMenuStyle = css({
  position: 'fixed',
  zIndex: 100,
  background: 'var(--bg, #fffcf0)',
  border: '1px solid #cecdc3',
  borderRadius: '6px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
  padding: '4px',
  display: 'flex',
  flexDirection: 'column',
  minWidth: '140px',
})

const contextMenuItemStyle = css({
  padding: '6px 12px',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  cursor: 'pointer',
  font: 'inherit',
  borderRadius: '4px',
  '&:hover': { background: '#f2f0e5' },
})

const renameInputStyle = css({
  padding: '2px 4px',
  border: '1px solid #205ea6',
  borderRadius: '3px',
  font: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
})

const toastStyle = css({
  position: 'fixed',
  right: '16px',
  bottom: '16px',
  zIndex: 200,
  padding: '10px 14px',
  background: '#af3029',
  color: '#fffcf0',
  borderRadius: '6px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
  maxWidth: '320px',
  fontSize: '13px',
})
```

- [ ] **Step 6: Run typecheck**

```sh
npm run typecheck
```

Expected: clean.

- [ ] **Step 7: Smoke-render**

```sh
PORT=44930 npx tsx server.ts &
sleep 3
curl -s http://localhost:44930/ > /tmp/marky-ui.html
grep -c "Rename\|Delete" /tmp/marky-ui.html || true
kill %1 2>/dev/null
```

Expected: 0 — the menu only renders when triggered, not in the SSR output. We're just confirming the page doesn't crash.

- [ ] **Step 8: Commit**

```sh
git add app/ui/editor/editor-app.tsx
git commit -m "editor: right-click rename and delete via context menu"
```

---

### Task 6: Live smoke test with chrome-devtools

**Files:** None — this task verifies behavior end-to-end.

- [ ] **Step 1: Boot the server with git enabled**

In one terminal:

```sh
mkdir -p /tmp/marky-smoke/content
cd /tmp/marky-smoke
git init -b main
git config --local user.name Seed
git config --local user.email seed@example.com
echo "hello" > content/Existing.md
git add -A && git commit -m seed
cd -

MARKY_AUTH=anonymous \
MARKY_GIT_REPO=/tmp/marky-smoke \
MARKY_CONTENT_DIR=/tmp/marky-smoke/content \
MARKY_PERSIST_IDLE_MS=2000 \
PORT=44940 npx tsx server.ts
```

Keep the terminal open. You should see `marky: 1 markdown files loaded`.

- [ ] **Step 2: Open in a browser and click the file**

Navigate to `http://localhost:44940/`. Click `Existing` in the file list. Type a change.

- [ ] **Step 3: Wait 2 seconds and check git log**

```sh
cd /tmp/marky-smoke
git log --oneline
```

Expected: a new commit on top of `seed`, with a message like `edit Existing.md — Anonymous Buttercup` (the random anonymous name). The HEAD's author is `marky-bot <marky-bot@...>`.

- [ ] **Step 4: Test rename**

In the browser, right-click `Existing` → Rename. Change to `Renamed`. Press Enter.

Wait 2 seconds.

```sh
git log --oneline
ls content/
```

Expected: `content/Existing.md` is gone, `content/Renamed.md` exists with the same content. New commit `rename Existing.md → Renamed.md — Anonymous Buttercup`.

- [ ] **Step 5: Test delete**

In the browser, right-click `Renamed` → Delete → confirm.

Wait 2 seconds.

```sh
git log --oneline
ls content/
```

Expected: file gone, new commit `delete Renamed.md — Anonymous Buttercup`.

- [ ] **Step 6: Test rename collision**

Create two files (`A` and `B`) by typing names in the sidebar input + clicking New. Wait briefly so they exist on disk. Then right-click `A` → Rename → type `B` → Enter.

Expected: a red toast appears in the bottom-right with the text `Cannot rename: B.md already exists.`. The sidebar still shows both files. Neither file's contents change.

- [ ] **Step 7: Clean up**

```sh
kill %1   # stop the server in the other terminal
rm -rf /tmp/marky-smoke
```

If everything above worked, the feature is fully shipped end-to-end.

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.env.example`

- [ ] **Step 1: Extend the env-var table in `README.md`**

Find the existing env-var table (`## Full env vars` section). Add these rows
between the discord rows and the bot-token row:

```md
| `MARKY_GIT_REPO` | both | no | Absolute path to a git repo. When set, marky stages and commits via this repo on every flush. When unset, marky only writes files to disk. |
| `MARKY_GIT_AUTHOR_NAME` | git | no | Commit author name. Default `marky-bot`. |
| `MARKY_GIT_AUTHOR_EMAIL` | git | no | Commit author email. Default `marky-bot@<MARKY_BASE_URL host>` or `marky-bot@localhost`. |
| `MARKY_GIT_PUSH` | git | no | `true` to enable periodic push. Requires `MARKY_GIT_PAT`. Default off. |
| `MARKY_GIT_PAT` | git | when `MARKY_GIT_PUSH=true` | GitHub PAT used for push auth. Never written to disk. |
| `MARKY_PERSIST_IDLE_MS` | both | no | Per-file debounce window in ms. Default 60000. |
| `MARKY_PUSH_INTERVAL_MS` | git | no | Periodic push frequency in ms. Default 300000. 0 disables. |
```

- [ ] **Step 2: Add a "Persistence" section to `README.md`**

After the "Auth modes" section, before "Development", add:

```md
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
```

- [ ] **Step 3: Add a "Persistence and Git" section to `AGENTS.md`**

After the "Auth Modes" section:

```md
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
```

- [ ] **Step 4: Extend `.env.example`**

Append below the existing entries:

```
# Optional. Path to a git repo to commit edits into. When unset, marky only
# writes to disk and never invokes git.
# MARKY_GIT_REPO=/repo

# Optional. Override commit author identity.
# MARKY_GIT_AUTHOR_NAME=marky-bot
# MARKY_GIT_AUTHOR_EMAIL=marky-bot@example.com

# Optional. Push to origin periodically. Requires MARKY_GIT_PAT.
# MARKY_GIT_PUSH=true
# MARKY_GIT_PAT=ghp_...

# Optional. Per-file debounce and push interval (ms). Defaults: 60000, 300000.
# MARKY_PERSIST_IDLE_MS=60000
# MARKY_PUSH_INTERVAL_MS=300000
```

- [ ] **Step 5: Verify tests still pass**

```sh
npm run typecheck
npm test
```

Expected: no test changes; both still pass.

- [ ] **Step 6: Commit**

```sh
git add README.md AGENTS.md .env.example
git commit -m "docs: add git-attributed persist + file ops"
```

---

## Plan-end verification

- [ ] Full test suite + typecheck

```sh
npm run typecheck
npm test
```

Both exit 0.

- [ ] Tag the merged commit with a manual smoke checklist completion note in the PR description.

After this plan: marky has auto-persist with debounced per-file commits, multi-author attribution in the commit message, right-click rename/delete in the UI, an error toast for server-rejected operations, and no manual Persist button. The full feature is shipped.
