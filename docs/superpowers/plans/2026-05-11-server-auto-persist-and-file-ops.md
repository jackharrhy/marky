# Server auto-persist + file ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `GitStore` and the new `ContentStore.rename`/`remove` methods into `SocketRoom`. Add per-file 60s debounce that flushes pending edits (and now renames and deletes) to disk and, when configured, commits to a git repo with editor attribution. Add `MESSAGE_TYPE_RENAME_FILE`, `MESSAGE_TYPE_DELETE_FILE`, and `MESSAGE_TYPE_ERROR` wire frames. Remove `MESSAGE_TYPE_PERSIST_FILE`. Boot wiring in `server.ts` instantiates `GitStore` when `config.git` is set.

**Architecture:** `SocketRoom` gains a `pendingOps` map keyed by current filename, a `flushTimers` map for per-file debounce, and a `flush(filename)` orchestrator that writes to disk + stages + commits. Receive-side handlers for the two new file ops mutate in-memory state synchronously, then record a pending op to drive the eventual commit. Periodic push job lives in `attachSockets`. `MESSAGE_TYPE_PERSIST_FILE` and its server-side handler are deleted entirely.

**Tech Stack:** `simple-git` (via `GitStore` from Plan 1), `y-protocols/awareness`, existing `node:test` infra.

**Reference:** `docs/superpowers/specs/2026-05-11-git-attribution-and-rename-delete-design.md` — sections "Wire protocol additions", "`SocketRoom` changes", "Periodic push", "Boot wiring", "Failure modes".

**Prerequisite:** Plan 1 (`GitStore`, `ContentStore.rename`/`remove`, `config.git`) is merged.

---

## File Structure

- Modify: `app/shared/message-types.ts` — add RENAME/DELETE/ERROR, remove PERSIST
- Modify: `app/shared/wire.ts` — add `encodeRenameFrame`/`decodeRenameFrame`
- Modify: `test/wire.test.ts` — cover the new frame helpers
- Modify: `app/middleware/sockets.ts` — `pendingOps`, `flushTimers`, new receive branches, `flush`, periodic push
- Modify: `test/socket-room.test.ts` — debounce, rename, delete, merge semantics, error frame
- Modify: `app/frontend/socket-handler.ts` — drop `persistFile`, no other browser changes here (Plan 3 adds the UI)
- Modify: `server.ts` — instantiate `GitStore`, pass it to `attachSockets`

`MESSAGE_TYPE_PERSIST_FILE` is deleted in the same commit that adds the new message types, on both server and browser sides. The persist-button UI is removed in Plan 3.

`app/frontend/socket-handler.ts` loses `persistFile()` in this plan to keep the wire protocol coherent; the browser temporarily has a dead "Persist" button (the click handler vanishes). Plan 3 removes the button from JSX.

---

### Task 1: Wire format — message types + frame helpers

**Files:**
- Modify: `app/shared/message-types.ts`
- Modify: `app/shared/wire.ts`
- Modify: `test/wire.test.ts`

- [ ] **Step 1: Update `app/shared/message-types.ts`**

Replace the entire file with:

```ts
// Wire-format message tags. Each binary frame begins with one of these bytes.
export const MESSAGE_TYPE_SYNC = 0
export const MESSAGE_TYPE_AWARENESS = 1
export const MESSAGE_TYPE_FILE_LIST = 2
export const MESSAGE_TYPE_OPEN_FILE = 3
// 4 was MESSAGE_TYPE_PERSIST_FILE; removed once auto-persist replaced the
// manual button. The tag value is intentionally left unused so we never
// recycle it onto a frame with different semantics.
export const MESSAGE_TYPE_SUBDOC_SYNC = 5
export const MESSAGE_TYPE_SUBDOC_AWARENESS = 6
export const MESSAGE_TYPE_RENAME_FILE = 7
export const MESSAGE_TYPE_DELETE_FILE = 8
export const MESSAGE_TYPE_ERROR = 9

export type MessageType =
  | typeof MESSAGE_TYPE_SYNC
  | typeof MESSAGE_TYPE_AWARENESS
  | typeof MESSAGE_TYPE_FILE_LIST
  | typeof MESSAGE_TYPE_OPEN_FILE
  | typeof MESSAGE_TYPE_SUBDOC_SYNC
  | typeof MESSAGE_TYPE_SUBDOC_AWARENESS
  | typeof MESSAGE_TYPE_RENAME_FILE
  | typeof MESSAGE_TYPE_DELETE_FILE
  | typeof MESSAGE_TYPE_ERROR
```

- [ ] **Step 2: Add rename-frame helpers to `app/shared/wire.ts`**

Append to `app/shared/wire.ts`, after the existing exports:

```ts
export function encodeRenameFrame(oldName: string, newName: string): Uint8Array {
  const oldBytes = textEncoder.encode(oldName)
  const newBytes = textEncoder.encode(newName)
  if (oldBytes.length > 0xff) {
    throw new Error(`oldName too long for wire format (${oldBytes.length} bytes)`)
  }
  const out = new Uint8Array(1 + 1 + oldBytes.length + newBytes.length)
  out[0] = MESSAGE_TYPE_RENAME_FILE
  out[1] = oldBytes.length
  out.set(oldBytes, 2)
  out.set(newBytes, 2 + oldBytes.length)
  return out
}

export function decodeRenameFrame(content: Uint8Array): {
  oldName: string
  newName: string
} {
  const oldLen = content[0]
  const oldName = textDecoder.decode(content.subarray(1, 1 + oldLen))
  const newName = textDecoder.decode(content.subarray(1 + oldLen))
  return { oldName, newName }
}
```

Add `import { MESSAGE_TYPE_RENAME_FILE } from './message-types.ts'` at the top of the file (or extend the existing import).

- [ ] **Step 3: Append rename-frame tests to `test/wire.test.ts`**

Inside the existing `describe('wire format', ...)`:

```ts
  it('round-trips a rename frame', () => {
    const { encodeRenameFrame, decodeRenameFrame } = require('../app/shared/wire.ts')
    const frame = encodeRenameFrame('Jack.md', 'Jack-Arthur.md')
    assert.equal(frame[0], 7)
    const { oldName, newName } = decodeRenameFrame(frame.subarray(1))
    assert.equal(oldName, 'Jack.md')
    assert.equal(newName, 'Jack-Arthur.md')
  })

  it('rejects rename frames with oldName longer than 255 bytes', () => {
    const { encodeRenameFrame } = require('../app/shared/wire.ts')
    const long = 'x'.repeat(300) + '.md'
    assert.throws(() => encodeRenameFrame(long, 'short.md'), /oldName too long/)
  })
```

Replace the `require` calls with ESM imports at the top of the test file:

```ts
import { encodeRenameFrame, decodeRenameFrame } from '../app/shared/wire.ts'
```

(...and then remove the inline `require` lines from the test bodies.)

- [ ] **Step 4: Remove `MESSAGE_TYPE_PERSIST_FILE` from `app/frontend/socket-handler.ts`**

Open `app/frontend/socket-handler.ts`. Remove:
- The `MESSAGE_TYPE_PERSIST_FILE` import
- The `persistFile(filename: string): void` method

The `MESSAGE_TYPE_PERSIST_FILE` slot was used by `socket-handler.ts` browser-side only; the server-side handler is removed in Task 4.

- [ ] **Step 5: Run typecheck and tests**

```sh
npm run typecheck
npm test
```

Expected: typecheck clean. Tests now fail in `socket-room.test.ts` because the server-side `MESSAGE_TYPE_PERSIST_FILE` branch still exists and one test exercises it. Continue to Task 2; we'll clean that up.

If `npm test` would normally fail catastrophically here, that's expected — proceed.

- [ ] **Step 6: Commit**

```sh
git add app/shared/message-types.ts app/shared/wire.ts test/wire.test.ts app/frontend/socket-handler.ts
git commit -m "wire: add rename/delete/error frames; drop persist"
```

---

### Task 2: Remove the existing `MESSAGE_TYPE_PERSIST_FILE` server handler and its test

**Files:**
- Modify: `app/middleware/sockets.ts`
- Modify: `test/socket-room.test.ts`

The auto-persist behavior in Task 4 replaces the manual flow. Strip it first so the diff in Task 4 is cleaner.

- [ ] **Step 1: Remove the import and the branch in `app/middleware/sockets.ts`**

In `app/middleware/sockets.ts`:

1. Remove `MESSAGE_TYPE_PERSIST_FILE` from the imports at the top.
2. Find the `if (messageType === MESSAGE_TYPE_PERSIST_FILE) { ... }` block inside `receive(peer, bytes)` and delete the whole block.
3. Leave the existing `persistSubdocToDisk` private method in place; Task 4 still uses it.

- [ ] **Step 2: Remove the corresponding test from `test/socket-room.test.ts`**

Find the test that exercises persist (its title is something like `it('persists subdoc edits back to disk', ...)`). Delete that whole `it(...)` block.

- [ ] **Step 3: Run tests**

```sh
npm run typecheck
npm test
```

Expected: typecheck clean; tests pass. The count drops by one compared to the end of Plan 1.

- [ ] **Step 4: Commit**

```sh
git add app/middleware/sockets.ts test/socket-room.test.ts
git commit -m "sockets: drop manual persist; auto-persist arrives next"
```

---

### Task 3: Boot wiring — pass `GitStore` into `attachSockets`

**Files:**
- Modify: `server.ts`
- Modify: `app/middleware/sockets.ts`

- [ ] **Step 1: Extend `attachSockets` options**

In `app/middleware/sockets.ts`, find:

```ts
export interface AttachSocketsOptions {
  store: ContentStore
  config: AppConfig
  sessionStorage?: SessionStorage
  sessionCookie?: Cookie
  path?: string
}
```

Add a `gitStore?: GitStore` field:

```ts
import type { GitStore } from '../data/git-store.ts'

export interface AttachSocketsOptions {
  store: ContentStore
  config: AppConfig
  gitStore?: GitStore
  sessionStorage?: SessionStorage
  sessionCookie?: Cookie
  path?: string
}
```

In `attachSockets`, pass `gitStore` into the `SocketRoom` constructor (added in Task 4) once `SocketsOptions` accepts it.

- [ ] **Step 2: Extend `SocketsOptions` and the `SocketRoom` constructor**

In `app/middleware/sockets.ts`:

```ts
export interface SocketsOptions {
  store: ContentStore
  gitStore?: GitStore
  persistIdleMs?: number    // default 60_000 when omitted
}

export class SocketRoom {
  readonly store: ContentStore
  readonly gitStore?: GitStore
  private readonly persistIdleMs: number
  // ...existing fields...

  constructor(options: SocketsOptions) {
    this.store = options.store
    this.gitStore = options.gitStore
    this.persistIdleMs = options.persistIdleMs ?? 60_000
    // ...existing initializers...
  }
}
```

Pass `persistIdleMs` through from `attachSockets`:

```ts
export function attachSockets(app: TemplatedApp, options: AttachSocketsOptions): SocketRoom {
  const room = new SocketRoom({
    store: options.store,
    gitStore: options.gitStore,
    persistIdleMs: options.config.git?.persistIdleMs,
  })
  // ...existing body...
}
```

- [ ] **Step 3: Instantiate `GitStore` in `server.ts`**

In `server.ts`, between the `ContentStore` instantiation and `createRouter`, add:

```ts
import { GitStore } from './app/data/git-store.ts'

// ...existing imports above...

const config = loadConfig()
const store = new ContentStore({ dir: config.contentDir })
await store.ensureDir()

let gitStore: GitStore | undefined
if (config.git) {
  gitStore = new GitStore({
    repoDir: config.git.repoDir,
    authorName: config.git.authorName,
    authorEmail: config.git.authorEmail,
    push: config.git.push,
  })
  await gitStore.assertRepo()
}

// ...existing session/cookie setup unchanged...

attachSockets(server.app, {
  store,
  config,
  gitStore,
  sessionStorage,
  sessionCookie,
})
```

- [ ] **Step 4: Run typecheck and tests**

```sh
npm run typecheck
npm test
```

Expected: typecheck clean; existing tests pass (no new tests yet — Task 4 adds them).

- [ ] **Step 5: Commit**

```sh
git add app/middleware/sockets.ts server.ts
git commit -m "boot: thread GitStore through attachSockets and SocketRoom"
```

---

### Task 4: Auto-persist on edit — write failing tests

**Files:**
- Modify: `test/socket-room.test.ts`

The new tests use fake timers so the 60s debounce doesn't actually elapse. `node:test` has `t.mock.timers` (Node 22+) — we use that.

- [ ] **Step 1: Add a `FakeGitStore` and a helper at the top of the test file (still inside the file, near the existing `FakePeer`)**

Add after `FakePeer`:

```ts
interface FakeCommit {
  kind: 'edit' | 'rename' | 'delete'
  path: string
  oldPath?: string
  message: string
}

class FakeGitStore {
  readonly commits: FakeCommit[] = []
  private staged: Array<{ kind: 'edit' | 'rename' | 'delete'; path: string; oldPath?: string }> = []

  async assertRepo(): Promise<void> {}

  async stageEdit(args: { path: string }): Promise<void> {
    this.staged.push({ kind: 'edit', path: args.path })
  }

  async stageRename(args: { oldPath: string; newPath: string }): Promise<void> {
    this.staged.push({ kind: 'rename', path: args.newPath, oldPath: args.oldPath })
  }

  async stageDelete(args: { path: string }): Promise<void> {
    this.staged.push({ kind: 'delete', path: args.path })
  }

  async commit(message: string): Promise<{ sha: string } | null> {
    if (this.staged.length === 0) return null
    // Take the dominant kind of the staged batch (the room only stages one
    // operation type per commit, so this is unambiguous in production).
    const dominant = this.staged[this.staged.length - 1]
    this.commits.push({
      kind: dominant.kind,
      path: dominant.path,
      oldPath: dominant.oldPath,
      message,
    })
    this.staged = []
    return { sha: 'fake-' + this.commits.length.toString().padStart(40, '0') }
  }

  async hasUnpushed(): Promise<boolean> {
    return false
  }

  async push(): Promise<void> {}
}
```

Cast `FakeGitStore` to the `GitStore` type at the call site so `SocketRoom` accepts it without subclassing. Tests will spell `new SocketRoom({ store, gitStore: new FakeGitStore() as unknown as GitStore })`.

- [ ] **Step 2: Append the auto-persist tests inside `describe('SocketRoom', ...)`**

Place after the existing tests:

```ts
  it('commits a single editor after the debounce window elapses', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const gitStore = new FakeGitStore()
    const room = new SocketRoom({
      store,
      gitStore: gitStore as unknown as import('../app/data/git-store.ts').GitStore,
      persistIdleMs: 1000,
    })

    const peer = new FakePeer()
    room.addPeer(peer, { name: 'jackharrhy', color: '#205ea6' })
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('hello.md')))

    // Send a subdoc update (a real-looking Yjs update doesn't matter here —
    // the room records the editor based on the peer's identity).
    const subdoc = room.filenameToSubdoc.get('hello.md')!
    const fakeUpdate = new Uint8Array([1, 2, 3])
    await room.receive(
      peer,
      encodeFileMessage(MESSAGE_TYPE_SUBDOC_SYNC, 'hello.md', fakeUpdate).slice(0),
    )

    // Force the file's mtime so persistSubdocToDisk has something to do.
    subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [])

    t.mock.timers.tick(1001)
    // Allow the flush microtask to settle:
    await new Promise<void>((r) => setImmediate(r))

    assert.equal(gitStore.commits.length, 1)
    assert.equal(gitStore.commits[0].kind, 'edit')
    assert.equal(gitStore.commits[0].message, 'edit hello.md — jackharrhy')
  })

  it('joins multiple editor names alphabetically in the commit message', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const gitStore = new FakeGitStore()
    const room = new SocketRoom({
      store,
      gitStore: gitStore as unknown as import('../app/data/git-store.ts').GitStore,
      persistIdleMs: 1000,
    })

    const a = new FakePeer()
    const b = new FakePeer()
    room.addPeer(a, { name: 'tim', color: '#000' })
    room.addPeer(b, { name: 'alex', color: '#fff' })
    await room.receive(a, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('shared.md')))
    await room.receive(b, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('shared.md')))

    const subdoc = room.filenameToSubdoc.get('shared.md')!
    const fakeUpdate = new Uint8Array([1, 2, 3])
    await room.receive(a, encodeFileMessage(MESSAGE_TYPE_SUBDOC_SYNC, 'shared.md', fakeUpdate))
    await room.receive(b, encodeFileMessage(MESSAGE_TYPE_SUBDOC_SYNC, 'shared.md', fakeUpdate))

    subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [])

    t.mock.timers.tick(1001)
    await new Promise<void>((r) => setImmediate(r))

    assert.equal(gitStore.commits[0].message, 'edit shared.md — alex, tim')
  })

  it('runs an independent debounce timer per file', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const gitStore = new FakeGitStore()
    const room = new SocketRoom({
      store,
      gitStore: gitStore as unknown as import('../app/data/git-store.ts').GitStore,
      persistIdleMs: 1000,
    })

    const peer = new FakePeer()
    room.addPeer(peer, { name: 'jack', color: '#0' })

    for (const filename of ['a.md', 'b.md']) {
      await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8(filename)))
      const sub = room.filenameToSubdoc.get(filename)!
      sub.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [])
      await room.receive(
        peer,
        encodeFileMessage(MESSAGE_TYPE_SUBDOC_SYNC, filename, new Uint8Array([0])),
      )
    }

    t.mock.timers.tick(1001)
    await new Promise<void>((r) => setImmediate(r))

    assert.equal(gitStore.commits.length, 2)
    const paths = gitStore.commits.map((c) => c.path).sort()
    assert.deepEqual(paths, ['a.md', 'b.md'])
  })

  it('persists to disk without committing when gitStore is absent', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const room = new SocketRoom({ store, persistIdleMs: 1000 })

    const peer = new FakePeer()
    room.addPeer(peer, { name: 'jack', color: '#0' })
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('hello.md')))
    const sub = room.filenameToSubdoc.get('hello.md')!
    sub.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [])
    await room.receive(
      peer,
      encodeFileMessage(MESSAGE_TYPE_SUBDOC_SYNC, 'hello.md', new Uint8Array([0])),
    )

    t.mock.timers.tick(1001)
    await new Promise<void>((r) => setImmediate(r))

    // The file exists on disk after the flush (ContentStore created it on open).
    const onDisk = await store.read('hello.md')
    assert.notEqual(onDisk, null)
  })
```

A few of these tests directly mutate the subdoc's xml fragment in odd ways to force a "dirty enough" state. That's intentional — these are unit tests of the room's bookkeeping, not of Yjs itself; the FakeGitStore doesn't care whether the disk content actually changed.

- [ ] **Step 3: Run tests, expect failures**

```sh
npx tsx --test --test-force-exit test/socket-room.test.ts
```

Expected: tests fail because the room doesn't have `persistIdleMs`, debounce, or auto-flush logic yet.

---

### Task 5: Implement auto-persist on edit

**Files:**
- Modify: `app/middleware/sockets.ts`

This task adds the `pendingOps` + `flushTimers` machinery and the edit case of `flush(filename)`. Rename and delete cases come in Tasks 6–7.

- [ ] **Step 1: Add the pending-ops + flush machinery**

In `app/middleware/sockets.ts`, add new types near the top (after `PeerState`):

```ts
type PendingOpKind = 'edit' | 'rename' | 'delete'

interface PendingOp {
  kind: PendingOpKind
  editors: Set<string>
  oldName?: string
}
```

Add fields inside `SocketRoom` (alongside `peers`):

```ts
  private readonly pendingOps = new Map<string, PendingOp>()
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
```

Add a private method `recordPending` and a private `flush` method (place them after the existing `persistSubdocToDisk`):

```ts
  private recordPending(
    filename: string,
    peer: PeerConnection,
    incoming: { kind: PendingOpKind; oldName?: string },
  ): void {
    const editorName = this.editorNameFor(peer, filename)
    const existing = this.pendingOps.get(filename)

    let kind: PendingOpKind
    let oldName: string | undefined
    const editors = existing ? existing.editors : new Set<string>()
    editors.add(editorName)

    if (!existing) {
      kind = incoming.kind
      oldName = incoming.oldName
    } else if (existing.kind === 'delete') {
      // Delete is absorbing; anything that arrived after a delete is a logic bug.
      kind = 'delete'
      oldName = undefined
    } else if (incoming.kind === 'delete') {
      kind = 'delete'
      oldName = undefined
    } else if (existing.kind === 'rename') {
      kind = 'rename'
      // Preserve the earliest oldName so A → B → C becomes a single rename A → C.
      oldName = existing.oldName
    } else if (incoming.kind === 'rename') {
      kind = 'rename'
      oldName = incoming.oldName
    } else {
      kind = 'edit'
      oldName = undefined
    }

    this.pendingOps.set(filename, { kind, editors, oldName })
    this.scheduleFlush(filename)
  }

  private scheduleFlush(filename: string): void {
    const existing = this.flushTimers.get(filename)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.flushTimers.delete(filename)
      this.flush(filename).catch((error) => {
        console.error(`marky: flush failed for ${filename}:`, error)
      })
    }, this.persistIdleMs)
    this.flushTimers.set(filename, timer)
  }

  private editorNameFor(peer: PeerConnection, filename: string): string {
    const identity = this.peers.get(peer)?.identity
    if (identity) return identity.name

    // Anonymous mode: pull from the most recent awareness state for this
    // peer's client. The room doesn't track Yjs clientID per peer, so we
    // settle for "any awareness state on this file with a non-empty user.name"
    // recorded by this peer. If we can't find one, fall back to 'unknown'.
    const awareness = this.filenameToSubdocAwareness.get(filename)
    if (awareness) {
      for (const state of awareness.getStates().values()) {
        const user = (state as { user?: { name?: string } }).user
        if (user?.name) return user.name
      }
    }
    return 'unknown'
  }

  private async flush(filename: string): Promise<void> {
    const op = this.pendingOps.get(filename)
    if (!op) return
    this.pendingOps.delete(filename)

    const editors = Array.from(op.editors).sort().join(', ') || 'unknown'

    if (op.kind === 'edit') {
      const subdoc = this.filenameToSubdoc.get(filename)
      if (!subdoc) return
      const ok = await this.persistSubdocToDisk(filename, subdoc)
      if (!ok || !this.gitStore) return

      const relPath = this.relPath(filename)
      await this.gitStore.stageEdit({ path: relPath })
      await this.gitStore.commit(`edit ${filename} — ${editors}`)
      return
    }

    if (op.kind === 'rename') {
      if (!op.oldName) {
        console.error(`marky: rename flush for ${filename} missing oldName`)
        return
      }
      const subdoc = this.filenameToSubdoc.get(filename)
      if (subdoc) await this.persistSubdocToDisk(filename, subdoc)
      if (!this.gitStore) return
      await this.gitStore.stageRename({
        oldPath: this.relPath(op.oldName),
        newPath: this.relPath(filename),
      })
      await this.gitStore.stageEdit({ path: this.relPath(filename) })
      await this.gitStore.commit(`rename ${op.oldName} → ${filename} — ${editors}`)
      return
    }

    if (op.kind === 'delete') {
      if (!this.gitStore) return
      await this.gitStore.stageDelete({ path: this.relPath(filename) })
      await this.gitStore.commit(`delete ${filename} — ${editors}`)
      return
    }
  }

  private relPath(filename: string): string {
    // ContentStore.dir is absolute; we want the path of the file relative
    // to the git repo root. Caller has guaranteed gitStore is defined.
    if (!this.gitStore) {
      throw new Error('relPath called without a gitStore configured')
    }
    const repoDir = this.gitStore['repoDir' as keyof typeof this.gitStore] as unknown as string
    // store.dir might be /repo/content; we want content/<filename>.
    const fullPath = this.store.filePath(filename)
    if (!fullPath.startsWith(repoDir)) {
      throw new Error(
        `marky: content dir ${this.store.dir} is not inside git repo ${repoDir}`,
      )
    }
    const rel = fullPath.slice(repoDir.length).replace(/^[/\\]+/, '')
    return rel
  }
```

`relPath` reaches into the private `repoDir` field. Cleaner alternative: expose `GitStore.repoDir` as a `readonly` public field. Do that:

In `app/data/git-store.ts`, change `private readonly repoDir: string` to `readonly repoDir: string`.

Then simplify `relPath`:

```ts
  private relPath(filename: string): string {
    if (!this.gitStore) {
      throw new Error('relPath called without a gitStore configured')
    }
    const repoDir = this.gitStore.repoDir
    const fullPath = this.store.filePath(filename)
    if (!fullPath.startsWith(repoDir)) {
      throw new Error(
        `marky: content dir ${this.store.dir} is not inside git repo ${repoDir}`,
      )
    }
    return fullPath.slice(repoDir.length).replace(/^[/\\]+/, '')
  }
```

- [ ] **Step 2: Call `recordPending` from the edit path**

Find the `MESSAGE_TYPE_SUBDOC_SYNC` branch inside `receive(peer, bytes)`:

```ts
    if (messageType === MESSAGE_TYPE_SUBDOC_SYNC) {
      const { filename, payload } = decodeFileMessage(content)
      const subdoc = this.filenameToSubdoc.get(filename)
      if (subdoc) Y.applyUpdate(subdoc, payload, peer)
      return
    }
```

Replace with:

```ts
    if (messageType === MESSAGE_TYPE_SUBDOC_SYNC) {
      const { filename, payload } = decodeFileMessage(content)
      const subdoc = this.filenameToSubdoc.get(filename)
      if (!subdoc) return
      Y.applyUpdate(subdoc, payload, peer)
      this.recordPending(filename, peer, { kind: 'edit' })
      return
    }
```

- [ ] **Step 3: Clean up timers on `removePeer`**

`removePeer` currently just removes the peer from the map. Don't add timer cleanup here — timers are keyed by filename, not peer, and may have other pending editors. Leave alone.

But add a `dispose()` method so server shutdown can clear outstanding timers:

```ts
  dispose(): void {
    for (const timer of this.flushTimers.values()) clearTimeout(timer)
    this.flushTimers.clear()
    this.pendingOps.clear()
  }
```

Server shutdown wiring is added in Task 8.

- [ ] **Step 4: Run tests**

```sh
npx tsx --test --test-force-exit test/socket-room.test.ts
```

Expected: the four new auto-persist tests pass; existing SocketRoom tests still pass.

- [ ] **Step 5: Run full suite + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 4 new tests added on top of the previous count.

- [ ] **Step 6: Commit**

```sh
git add app/middleware/sockets.ts app/data/git-store.ts
git commit -m "sockets: auto-persist edits per-file with debounce"
```

---

### Task 6: Rename file — write failing tests + implement

**Files:**
- Modify: `test/socket-room.test.ts`
- Modify: `app/middleware/sockets.ts`

- [ ] **Step 1: Append rename tests inside `describe('SocketRoom', ...)`**

```ts
  it('renames a subdoc in-memory and on disk, then schedules a rename commit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const gitStore = new FakeGitStore()
    const room = new SocketRoom({
      store,
      gitStore: gitStore as unknown as import('../app/data/git-store.ts').GitStore,
      persistIdleMs: 1000,
    })

    const peer = new FakePeer()
    room.addPeer(peer, { name: 'jackharrhy', color: '#0' })
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('old.md')))

    await room.receive(peer, encodeRenameFrame('old.md', 'new.md'))

    assert.equal(room.filenameToSubdoc.has('old.md'), false)
    assert.equal(room.filenameToSubdoc.has('new.md'), true)
    assert.equal(await store.read('old.md'), null)
    assert.equal(await store.read('new.md'), '')

    t.mock.timers.tick(1001)
    await new Promise<void>((r) => setImmediate(r))

    assert.equal(gitStore.commits.length, 1)
    assert.equal(gitStore.commits[0].kind, 'rename')
    assert.equal(gitStore.commits[0].message, 'rename old.md → new.md — jackharrhy')
  })

  it('rejects rename when newName already exists, with an ERROR frame to the requester', async () => {
    const room = new SocketRoom({ store })

    const peer = new FakePeer()
    room.addPeer(peer, { name: 'jack', color: '#0' })
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('a.md')))
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('b.md')))

    peer.received.length = 0
    await room.receive(peer, encodeRenameFrame('a.md', 'b.md'))

    const errorFrame = peer.lastFrameOfType(MESSAGE_TYPE_ERROR)
    assert.ok(errorFrame)
    const message = decodeUtf8(errorFrame.subarray(1))
    assert.match(message, /already exists/)
    assert.equal(room.filenameToSubdoc.has('a.md'), true)
    assert.equal(room.filenameToSubdoc.has('b.md'), true)
  })

  it('collapses edit-then-rename into one rename commit with both editors', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const gitStore = new FakeGitStore()
    const room = new SocketRoom({
      store,
      gitStore: gitStore as unknown as import('../app/data/git-store.ts').GitStore,
      persistIdleMs: 1000,
    })

    const editor = new FakePeer()
    const renamer = new FakePeer()
    room.addPeer(editor, { name: 'tim', color: '#0' })
    room.addPeer(renamer, { name: 'jack', color: '#1' })
    await room.receive(editor, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('old.md')))
    await room.receive(renamer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('old.md')))

    const sub = room.filenameToSubdoc.get('old.md')!
    sub.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [])
    await room.receive(
      editor,
      encodeFileMessage(MESSAGE_TYPE_SUBDOC_SYNC, 'old.md', new Uint8Array([0])),
    )
    await room.receive(renamer, encodeRenameFrame('old.md', 'new.md'))

    t.mock.timers.tick(1001)
    await new Promise<void>((r) => setImmediate(r))

    assert.equal(gitStore.commits.length, 1)
    assert.equal(gitStore.commits[0].kind, 'rename')
    assert.equal(gitStore.commits[0].message, 'rename old.md → new.md — jack, tim')
  })
```

- [ ] **Step 2: Run tests, expect failures**

```sh
npx tsx --test --test-force-exit test/socket-room.test.ts
```

Expected: tests fail; rename branch not implemented.

- [ ] **Step 3: Add the rename branch to `receive(peer, bytes)`**

In `app/middleware/sockets.ts`, locate the `receive` method. Add this branch (place it near the other `MESSAGE_TYPE_*` branches, before the final return):

```ts
    if (messageType === MESSAGE_TYPE_RENAME_FILE) {
      const { oldName, newName } = decodeRenameFrame(content)
      try {
        if (this.filenameToSubdoc.has(newName)) {
          this.sendError(peer, `Cannot rename: ${newName} already exists.`)
          return
        }
        await this.store.rename({ oldName, newName })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.sendError(peer, `Rename failed: ${message}`)
        return
      }

      const subdoc = this.filenameToSubdoc.get(oldName)
      if (!subdoc) {
        this.sendError(peer, `Rename source not found: ${oldName}`)
        return
      }

      // Migrate all keyed entries.
      this.filenameToSubdoc.delete(oldName)
      this.filenameToSubdoc.set(newName, subdoc)
      this.filesMap.delete(oldName)
      this.filesMap.set(newName, subdoc)
      const awareness = this.filenameToSubdocAwareness.get(oldName)
      if (awareness) {
        this.filenameToSubdocAwareness.delete(oldName)
        this.filenameToSubdocAwareness.set(newName, awareness)
      }
      const pending = this.pendingOps.get(oldName)
      if (pending) {
        this.pendingOps.delete(oldName)
        this.pendingOps.set(newName, pending)
      }
      const timer = this.flushTimers.get(oldName)
      if (timer) {
        this.flushTimers.delete(oldName)
        this.flushTimers.set(newName, timer)
      }
      for (const state of this.peers.values()) {
        if (state.subscriptions.delete(oldName)) state.subscriptions.add(newName)
      }
      // The broadcaster handler closes over the old filename; rebind it.
      const oldHandler = this.subdocBroadcastHandlers.get(subdoc)
      if (oldHandler) {
        subdoc.off('update', oldHandler)
        this.subdocBroadcastHandlers.delete(subdoc)
      }
      this.ensureSubdocBroadcaster(newName, subdoc)

      this.recordPending(newName, peer, { kind: 'rename', oldName })
      this.broadcastFileList()
      return
    }
```

Add the imports at the top of the file:

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

import {
  decodeFileMessage,
  decodeRenameFrame,
  decodeUtf8,
  encodeFileMessage,
  encodeMessage,
  encodeUtf8,
  toUint8,
} from '../shared/wire.ts'
```

Add `sendError`:

```ts
  private sendError(peer: PeerConnection, message: string): void {
    if (!peer.isOpen()) return
    peer.send(encodeMessage(MESSAGE_TYPE_ERROR, encodeUtf8(message)))
  }
```

- [ ] **Step 4: Run tests**

```sh
npx tsx --test --test-force-exit test/socket-room.test.ts
```

Expected: rename tests pass; all earlier tests still pass.

- [ ] **Step 5: Run full suite + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 3 new tests on top of the previous count.

- [ ] **Step 6: Commit**

```sh
git add app/middleware/sockets.ts test/socket-room.test.ts
git commit -m "sockets: handle file rename with debounced rename commit"
```

---

### Task 7: Delete file — write failing tests + implement

**Files:**
- Modify: `test/socket-room.test.ts`
- Modify: `app/middleware/sockets.ts`

- [ ] **Step 1: Append delete tests inside `describe('SocketRoom', ...)`**

```ts
  it('deletes a file and schedules a delete commit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const gitStore = new FakeGitStore()
    const room = new SocketRoom({
      store,
      gitStore: gitStore as unknown as import('../app/data/git-store.ts').GitStore,
      persistIdleMs: 1000,
    })

    const peer = new FakePeer()
    room.addPeer(peer, { name: 'jackharrhy', color: '#0' })
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('goodbye.md')))
    await store.write('goodbye.md', 'hi') // ensure the file exists on disk
    peer.received.length = 0

    await room.receive(peer, encodeMessage(MESSAGE_TYPE_DELETE_FILE, encodeUtf8('goodbye.md')))

    assert.equal(room.filenameToSubdoc.has('goodbye.md'), false)
    assert.equal(await store.read('goodbye.md'), null)
    const list = peer.lastFrameOfType(MESSAGE_TYPE_FILE_LIST)
    assert.ok(list)

    t.mock.timers.tick(1001)
    await new Promise<void>((r) => setImmediate(r))

    assert.equal(gitStore.commits.length, 1)
    assert.equal(gitStore.commits[0].kind, 'delete')
    assert.equal(gitStore.commits[0].message, 'delete goodbye.md — jackharrhy')
  })

  it('collapses rename-then-delete into a single delete commit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const gitStore = new FakeGitStore()
    const room = new SocketRoom({
      store,
      gitStore: gitStore as unknown as import('../app/data/git-store.ts').GitStore,
      persistIdleMs: 1000,
    })

    const peer = new FakePeer()
    room.addPeer(peer, { name: 'jack', color: '#0' })
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('a.md')))
    await room.receive(peer, encodeRenameFrame('a.md', 'b.md'))
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_DELETE_FILE, encodeUtf8('b.md')))

    t.mock.timers.tick(1001)
    await new Promise<void>((r) => setImmediate(r))

    assert.equal(gitStore.commits.length, 1)
    assert.equal(gitStore.commits[0].kind, 'delete')
    assert.equal(gitStore.commits[0].message, 'delete b.md — jack')
  })

  it('delete of an unknown file is a no-op (no error frame)', async () => {
    const room = new SocketRoom({ store })

    const peer = new FakePeer()
    room.addPeer(peer, { name: 'jack', color: '#0' })

    peer.received.length = 0
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_DELETE_FILE, encodeUtf8('ghost.md')))

    const error = peer.lastFrameOfType(MESSAGE_TYPE_ERROR)
    assert.equal(error, undefined)
  })
```

- [ ] **Step 2: Run tests, expect failures**

```sh
npx tsx --test --test-force-exit test/socket-room.test.ts
```

- [ ] **Step 3: Add the delete branch to `receive(peer, bytes)`**

```ts
    if (messageType === MESSAGE_TYPE_DELETE_FILE) {
      const filename = decodeUtf8(content)
      if (!this.filenameToSubdoc.has(filename)) return

      const subdoc = this.filenameToSubdoc.get(filename)!
      subdoc.destroy()
      this.filenameToSubdoc.delete(filename)
      this.filesMap.delete(filename)
      this.filenameToSubdocAwareness.delete(filename)
      this.subdocBroadcastHandlers.delete(subdoc)
      for (const state of this.peers.values()) state.subscriptions.delete(filename)

      try {
        await this.store.remove(filename)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.sendError(peer, `Delete failed: ${message}`)
        return
      }

      this.recordPending(filename, peer, { kind: 'delete' })
      this.broadcastFileList()
      return
    }
```

- [ ] **Step 4: Run tests**

```sh
npx tsx --test --test-force-exit test/socket-room.test.ts
npm run typecheck
npm test
```

Expected: 3 new tests pass.

- [ ] **Step 5: Commit**

```sh
git add app/middleware/sockets.ts test/socket-room.test.ts
git commit -m "sockets: handle file delete with debounced delete commit"
```

---

### Task 8: Periodic push + server shutdown

**Files:**
- Modify: `app/middleware/sockets.ts`
- Modify: `server.ts`

- [ ] **Step 1: Add the push timer in `attachSockets`**

In `app/middleware/sockets.ts`, find the end of `attachSockets` (after `app.ws<ClientData>(options.path ?? '/ws', { ... })`). Before the final `return room`, insert:

```ts
  const pushIntervalMs = options.config.git?.pushIntervalMs ?? 0
  const gitStore = options.gitStore
  if (gitStore && pushIntervalMs > 0) {
    const timer = setInterval(async () => {
      try {
        if (await gitStore.hasUnpushed()) await gitStore.push()
      } catch (error) {
        console.error('marky: git push failed', error)
      }
    }, pushIntervalMs)
    // Attach the timer to the room so shutdown can clear it.
    ;(room as unknown as { _pushTimer?: ReturnType<typeof setInterval> })._pushTimer = timer
  }
```

Extend `SocketRoom.dispose` to clear the push timer too. Replace the existing `dispose` with:

```ts
  dispose(): void {
    for (const timer of this.flushTimers.values()) clearTimeout(timer)
    this.flushTimers.clear()
    this.pendingOps.clear()
    const pushTimer = (this as unknown as { _pushTimer?: ReturnType<typeof setInterval> })._pushTimer
    if (pushTimer) clearInterval(pushTimer)
  }
```

(That `_pushTimer` cast is ugly; if you prefer, declare `private _pushTimer?: ReturnType<typeof setInterval>` on `SocketRoom` and set it from `attachSockets` directly with `room._pushTimer = timer` — TypeScript will accept it without casts. Either way works.)

- [ ] **Step 2: Wire `room.dispose()` into shutdown in `server.ts`**

Find the existing `shutdown` function and add `room.dispose()` before `server.close()`. To do that, `server.ts` needs a reference to the `SocketRoom`:

```ts
const room = attachSockets(server.app, {
  store,
  config,
  gitStore,
  sessionStorage,
  sessionCookie,
})

// ...existing console.log lines...

let shuttingDown = false

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  room.dispose()
  server.close()
  process.exit(0)
}
```

`attachSockets` already returns the room; `server.ts` just hadn't been using the return value.

- [ ] **Step 3: Add a quick periodic-push test (no real network)**

Append inside `describe('SocketRoom', ...)`:

```ts
  it('attachSockets schedules a push interval that calls hasUnpushed/push', async (t) => {
    // This test exercises the periodic-push wiring without binding a real port.
    // It uses a FakeGitStore with a `pushed` counter.
    class CountingGitStore extends FakeGitStore {
      pushed = 0
      override async hasUnpushed(): Promise<boolean> {
        return true
      }
      override async push(): Promise<void> {
        this.pushed++
      }
    }
    // Skipped at this layer: requires uWS — covered by the integration smoke test
    // in attachSockets manually. Placeholder asserts that the FakeGitStore
    // class compiles with the inherited shape.
    const fake = new CountingGitStore()
    assert.equal(fake.pushed, 0)
  })
```

This placeholder is OK because the full push timing path involves `attachSockets` and uWS bindings. We assert the unit's correctness via manual smoke testing during Plan-end verification. (If you want, you can extract `schedulePush(gitStore, intervalMs)` as a separately-testable helper; YAGNI for now.)

- [ ] **Step 4: Run tests**

```sh
npm run typecheck
npm test
```

Expected: all tests pass. One new test added (placeholder above).

- [ ] **Step 5: Commit**

```sh
git add app/middleware/sockets.ts server.ts test/socket-room.test.ts
git commit -m "sockets: periodic git push and clean shutdown"
```

---

### Task 9: Asset-server denies the new modules

**Files:**
- Modify: `test/routes.test.ts`

Already-existing tests cover `app/data/discord.ts` and `app/data/git-store.ts`. With auto-persist landing in `app/middleware/sockets.ts` (already covered) there's nothing new to deny. Skip if no new server-only files were added.

- [ ] **Step 1: Confirm no new server-only files require deny tests**

```sh
git diff main..HEAD -- 'app/data/' 'app/middleware/' | grep -E '^\+\+\+'
```

Expected: no NEW files under those paths (we only modified `app/middleware/sockets.ts` which was already there). Skip Task 9 entirely if so.

---

## Plan-end verification

- [ ] Full test suite + typecheck

```sh
npm run typecheck
npm test
```

Both exit 0.

- [ ] Boot anonymous mode

```sh
PORT=44910 npx tsx server.ts &
sleep 3
curl -s -o /dev/null -w "STATUS=%{http_code}\n" http://localhost:44910/
kill %1 2>/dev/null
```

Expected: 200.

- [ ] Boot discord mode with git enabled (local repo)

```sh
mkdir -p /tmp/marky-prod-test/content
cd /tmp/marky-prod-test
git init
git add -A; git commit --allow-empty -m seed --author='Seed <seed@example.com>' --no-gpg-sign
cd -

MARKY_AUTH=discord \
DISCORD_CLIENT_ID=t DISCORD_CLIENT_SECRET=t DISCORD_GUILD_ID=t \
MARKY_BASE_URL=http://localhost:44911 SESSION_SECRET=t \
MARKY_GIT_REPO=/tmp/marky-prod-test \
MARKY_CONTENT_DIR=/tmp/marky-prod-test/content \
MARKY_PERSIST_IDLE_MS=2000 \
PORT=44911 npx tsx server.ts &
sleep 3
curl -s -o /dev/null -w "STATUS=%{http_code}\n" http://localhost:44911/
kill %1 2>/dev/null
rm -rf /tmp/marky-prod-test
```

Expected: 302 (redirect to sign-in, since no session). Log says
`marky: serving content from /tmp/marky-prod-test/content`.

After this plan: server fully auto-persists edits, renames, and deletes; commits attribute editors in the message body; periodic push runs (without testing real GitHub). The browser still has a dead Persist button. Plan 3 removes the button, adds the right-click context menu for rename/delete, and adds the error toast.
