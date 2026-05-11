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
  MESSAGE_TYPE_FILE_LIST,
  MESSAGE_TYPE_OPEN_FILE,
  MESSAGE_TYPE_SUBDOC_SYNC,
  MESSAGE_TYPE_SYNC,
} from '../app/shared/message-types.ts'
import {
  decodeFileMessage,
  decodeUtf8,
  encodeMessage,
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
})
