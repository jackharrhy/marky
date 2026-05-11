import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import * as Y from 'yjs'

import { ContentStore } from '../app/data/content-store.ts'
import { SocketRoom, type PeerConnection } from '../app/middleware/sockets.ts'
import { PROSEMIRROR_FRAGMENT_NAME } from '../app/shared/constants.ts'
import { textToDoc } from '../app/shared/doc-utils.ts'
import {
  MESSAGE_TYPE_AWARENESS,
  MESSAGE_TYPE_DELETE_FILE,
  MESSAGE_TYPE_ERROR,
  MESSAGE_TYPE_FILE_LIST,
  MESSAGE_TYPE_OPEN_FILE,
  MESSAGE_TYPE_RENAME_FILE,
  MESSAGE_TYPE_SUBDOC_SYNC,
  MESSAGE_TYPE_SYNC,
} from '../app/shared/message-types.ts'
import {
  decodeFileMessage,
  decodeUtf8,
  encodeFileMessage,
  encodeMessage,
  encodeRenameFrame,
  encodeUtf8,
} from '../app/shared/wire.ts'
import { prosemirrorToYXmlFragment } from 'y-prosemirror'

class FakePeer implements PeerConnection {
  readonly received: Uint8Array[] = []
  private open = true

  send(frame: Uint8Array): void {
    this.received.push(frame)
  }
  isOpen(): boolean {
    return this.open
  }
  close(): void {
    this.open = false
  }

  framesOfType(type: number): Uint8Array[] {
    return this.received.filter((f) => f[0] === type)
  }

  lastFrameOfType(type: number): Uint8Array | undefined {
    const frames = this.framesOfType(type)
    return frames[frames.length - 1]
  }
}

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

  readonly repoDir: string = '/repo'
}

describe('SocketRoom', () => {
  let dir: string
  let store: ContentStore
  let room: SocketRoom

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marky-room-test-'))
    store = new ContentStore({ dir })
    await store.ensureDir()
    room = new SocketRoom({ store })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('greets a new peer with an empty file list', () => {
    const peer = new FakePeer()
    room.addPeer(peer)

    const sync = peer.lastFrameOfType(MESSAGE_TYPE_SYNC)
    assert.ok(sync, 'expected initial sync frame')

    const list = peer.lastFrameOfType(MESSAGE_TYPE_FILE_LIST)
    assert.ok(list, 'expected initial file list frame')
    assert.deepEqual(JSON.parse(decodeUtf8(list.subarray(1))), [])
  })

  it('lists existing files after rescan', async () => {
    await store.write('alpha.md', 'one')
    await store.write('beta.md', 'two')
    await room.rescan()

    const peer = new FakePeer()
    room.addPeer(peer)

    const list = peer.lastFrameOfType(MESSAGE_TYPE_FILE_LIST)
    assert.ok(list)
    const files = JSON.parse(decodeUtf8(list.subarray(1))) as string[]
    assert.deepEqual(files.sort(), ['alpha.md', 'beta.md'])
  })

  it('opens an existing file with its persisted contents', async () => {
    await store.write('hello.md', 'persisted body')
    await room.rescan()

    const peer = new FakePeer()
    room.addPeer(peer)
    peer.received.length = 0 // ignore initial frames

    await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('hello.md')))

    const subdocSync = peer.lastFrameOfType(MESSAGE_TYPE_SUBDOC_SYNC)
    assert.ok(subdocSync)
    const { filename, payload } = decodeFileMessage(subdocSync.subarray(1))
    assert.equal(filename, 'hello.md')

    // Apply the snapshot into a local Yjs doc and confirm the text matches.
    const local = new Y.Doc()
    Y.applyUpdate(local, payload)
    const fragment = local.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
    assert.equal(fragment.toString().includes('persisted body'), true)
  })

  it('broadcasts subdoc edits to subscribed peers', async () => {
    await store.write('shared.md', '')
    await room.rescan()

    const a = new FakePeer()
    const b = new FakePeer()
    room.addPeer(a)
    room.addPeer(b)

    // Both peers open the file.
    await room.receive(a, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('shared.md')))
    await room.receive(b, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('shared.md')))

    a.received.length = 0
    b.received.length = 0

    // Peer A makes an edit and the room broadcasts the update to subscribed peers.
    const subdoc = room.filenameToSubdoc.get('shared.md')!
    subdoc.transact(() => {
      const fragment = subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
      fragment.delete(0, fragment.length)
      prosemirrorToYXmlFragment(textToDoc('hello from A'), fragment)
    }, a)

    const bFrames = b.framesOfType(MESSAGE_TYPE_SUBDOC_SYNC)
    assert.ok(bFrames.length > 0, 'peer B should receive a subdoc sync from A')
    const { filename } = decodeFileMessage(bFrames[0].subarray(1))
    assert.equal(filename, 'shared.md')
  })

  it('overwrites awareness user for peers with an identity', async () => {
    const { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } = await import(
      'y-protocols/awareness'
    )

    // Build a real awareness frame as a peer would: a Y.Doc + Awareness with
    // a forged user state.
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    awareness.setLocalStateField('user', { name: 'forged', color: '#000000' })
    const update = encodeAwarenessUpdate(awareness, [awareness.clientID])

    const a = new FakePeer()
    const b = new FakePeer()
    room.addPeer(a, { name: 'real-jack', color: '#ff0000' })
    room.addPeer(b)

    await room.receive(a, encodeMessage(MESSAGE_TYPE_AWARENESS, update))

    const frame = b.lastFrameOfType(MESSAGE_TYPE_AWARENESS)
    assert.ok(frame, 'peer b should receive a broadcasted awareness frame')

    // Apply the broadcast frame into a fresh awareness and confirm the user
    // was rewritten to peer A's bound identity. The observer's constructor
    // seeds an empty local state so we look up the source clientID directly.
    const observerDoc = new Y.Doc()
    const observer = new Awareness(observerDoc)
    applyAwarenessUpdate(observer, frame.subarray(1), null)
    const sourceState = observer.getStates().get(awareness.clientID)
    assert.ok(sourceState, 'observer should have the source clientID state')
    assert.deepEqual(sourceState.user, { name: 'real-jack', color: '#ff0000' })
  })

  it('does not broadcast to peers who have not opened the file', async () => {
    await store.write('private.md', '')
    await room.rescan()

    const a = new FakePeer()
    const b = new FakePeer()
    room.addPeer(a)
    room.addPeer(b)

    await room.receive(a, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('private.md')))
    a.received.length = 0
    b.received.length = 0

    const subdoc = room.filenameToSubdoc.get('private.md')!
    subdoc.transact(() => {
      const fragment = subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
      prosemirrorToYXmlFragment(textToDoc('A made an edit'), fragment)
    }, a)

    assert.equal(b.framesOfType(MESSAGE_TYPE_SUBDOC_SYNC).length, 0)
  })

  it('commits a single editor after the debounce window elapses', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const fake = new FakeGitStore()
    ;(fake as any).repoDir = store.dir
    const room = new SocketRoom({
      store,
      gitStore: fake as unknown as import('../app/data/git-store.ts').GitStore,
      persistIdleMs: 1000,
    })

    const peer = new FakePeer()
    room.addPeer(peer, { name: 'jackharrhy', color: '#205ea6' })
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('hello.md')))

    const subdoc = room.filenameToSubdoc.get('hello.md')!
    // Force the subdoc to have content so persistSubdocToDisk actually writes.
    subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [])
    await room.receive(
      peer,
      encodeFileMessage(MESSAGE_TYPE_SUBDOC_SYNC, 'hello.md', new Uint8Array([0])),
    )

    t.mock.timers.tick(1001)
    await room.waitForFlushes()

    assert.equal(fake.commits.length, 1)
    assert.equal(fake.commits[0].kind, 'edit')
    assert.equal(fake.commits[0].message, 'edit hello.md — jackharrhy')
  })

  it('joins multiple editor names alphabetically in the commit message', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const fake = new FakeGitStore()
    ;(fake as any).repoDir = store.dir
    const room = new SocketRoom({
      store,
      gitStore: fake as unknown as import('../app/data/git-store.ts').GitStore,
      persistIdleMs: 1000,
    })

    const a = new FakePeer()
    const b = new FakePeer()
    room.addPeer(a, { name: 'tim', color: '#000' })
    room.addPeer(b, { name: 'alex', color: '#fff' })
    await room.receive(a, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('shared.md')))
    await room.receive(b, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('shared.md')))

    const subdoc = room.filenameToSubdoc.get('shared.md')!
    subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [])
    await room.receive(a, encodeFileMessage(MESSAGE_TYPE_SUBDOC_SYNC, 'shared.md', new Uint8Array([0])))
    await room.receive(b, encodeFileMessage(MESSAGE_TYPE_SUBDOC_SYNC, 'shared.md', new Uint8Array([0])))

    t.mock.timers.tick(1001)
    await room.waitForFlushes()

    assert.equal(fake.commits[0].message, 'edit shared.md — alex, tim')
  })

  it('runs an independent debounce timer per file', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const fake = new FakeGitStore()
    ;(fake as any).repoDir = store.dir
    const room = new SocketRoom({
      store,
      gitStore: fake as unknown as import('../app/data/git-store.ts').GitStore,
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
    await room.waitForFlushes()

    assert.equal(fake.commits.length, 2)
    const paths = fake.commits.map((c) => c.path).sort()
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
    await room.waitForFlushes()

    // The file exists on disk after the flush (ContentStore created it on open).
    const onDisk = await store.read('hello.md')
    assert.notEqual(onDisk, null)
  })

  it('renames a subdoc in-memory and on disk, then schedules a rename commit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const fake = new FakeGitStore()
    ;(fake as any).repoDir = store.dir
    const room = new SocketRoom({
      store,
      gitStore: fake as unknown as import('../app/data/git-store.ts').GitStore,
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
    await room.waitForFlushes()

    assert.equal(fake.commits.length, 1)
    assert.equal(fake.commits[0].kind, 'rename')
    assert.equal(fake.commits[0].message, 'rename old.md → new.md — jackharrhy')
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

    const fake = new FakeGitStore()
    ;(fake as any).repoDir = store.dir
    const room = new SocketRoom({
      store,
      gitStore: fake as unknown as import('../app/data/git-store.ts').GitStore,
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
    await room.waitForFlushes()

    assert.equal(fake.commits.length, 1)
    assert.equal(fake.commits[0].kind, 'rename')
    assert.equal(fake.commits[0].message, 'rename old.md → new.md — jack, tim')
  })

  it('deletes a file and schedules a delete commit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const fake = new FakeGitStore()
    ;(fake as any).repoDir = store.dir
    const room = new SocketRoom({
      store,
      gitStore: fake as unknown as import('../app/data/git-store.ts').GitStore,
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
    await room.waitForFlushes()

    assert.equal(fake.commits.length, 1)
    assert.equal(fake.commits[0].kind, 'delete')
    assert.equal(fake.commits[0].message, 'delete goodbye.md — jackharrhy')
  })

  it('collapses rename-then-delete into a single delete commit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const fake = new FakeGitStore()
    ;(fake as any).repoDir = store.dir
    const room = new SocketRoom({
      store,
      gitStore: fake as unknown as import('../app/data/git-store.ts').GitStore,
      persistIdleMs: 1000,
    })

    const peer = new FakePeer()
    room.addPeer(peer, { name: 'jack', color: '#0' })
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8('a.md')))
    await room.receive(peer, encodeRenameFrame('a.md', 'b.md'))
    await room.receive(peer, encodeMessage(MESSAGE_TYPE_DELETE_FILE, encodeUtf8('b.md')))

    t.mock.timers.tick(1001)
    await room.waitForFlushes()

    assert.equal(fake.commits.length, 1)
    assert.equal(fake.commits[0].kind, 'delete')
    assert.equal(fake.commits[0].message, 'delete b.md — jack')
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
})
