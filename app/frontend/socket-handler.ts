import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness'
import * as Y from 'yjs'

import {
  MESSAGE_TYPE_AWARENESS,
  MESSAGE_TYPE_FILE_LIST,
  MESSAGE_TYPE_OPEN_FILE,
  MESSAGE_TYPE_SUBDOC_AWARENESS,
  MESSAGE_TYPE_SUBDOC_SYNC,
  MESSAGE_TYPE_SYNC,
} from '../shared/message-types.ts'
import {
  decodeFileMessage,
  decodeUtf8,
  encodeFileMessage,
  encodeMessage,
  encodeUtf8,
  toUint8,
} from '../shared/wire.ts'
import type { User } from './user.ts'

export interface SocketHandlerCallbacks {
  onFileListUpdate: (files: string[]) => void
  onSubdocUpdate: (filename: string, subdoc: Y.Doc) => void
  onAwarenessUpdate?: () => void
  onSubdocAwarenessUpdate?: (filename: string) => void
}

export interface AwarenessClientState {
  user?: User
  currentFile?: string | null
}

// Browser-side counterpart to app/middleware/sockets.ts. Owns the websocket,
// the root Yjs doc, and the per-file subdoc/awareness maps.
export class SocketHandler {
  private readonly ws: WebSocket
  private readonly callbacks: SocketHandlerCallbacks
  readonly rootDoc: Y.Doc
  private readonly filesMap: Y.Map<Y.Doc>
  readonly awareness: Awareness
  private readonly filenameToSubdoc = new Map<string, Y.Doc>()
  private readonly filenameToSubdocAwareness = new Map<string, Awareness>()

  constructor(callbacks: SocketHandlerCallbacks) {
    this.callbacks = callbacks
    this.rootDoc = new Y.Doc()
    this.filesMap = this.rootDoc.getMap('files')
    this.awareness = new Awareness(this.rootDoc)

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
    this.ws.binaryType = 'arraybuffer'

    this.ws.addEventListener('open', () => this.handleOpen())
    this.ws.addEventListener('close', () => this.handleClose())
    this.ws.addEventListener('error', (event) =>
      console.error('marky: websocket error', event),
    )
    this.ws.addEventListener('message', (event) => {
      this.handleMessage(event).catch((error) =>
        console.error('marky: failed to handle ws message', error),
      )
    })

    this.rootDoc.on('update', (update: Uint8Array) => {
      this.send(encodeMessage(MESSAGE_TYPE_SYNC, update))
    })

    this.awareness.on('update', this.handleRootAwarenessUpdate)

    this.rootDoc.on(
      'subdocs',
      ({ loaded }: { loaded: Set<Y.Doc> }) => {
        for (const subdoc of loaded) {
          for (const filename of this.filesMap.keys()) {
            if (this.filesMap.get(filename) === subdoc) {
              this.registerSubdoc(filename, subdoc)
            }
          }
        }
      },
    )
  }

  // ---- Public API used by the editor controller -----------------------------

  setUser(user: User): void {
    this.awareness.setLocalStateField('user', user)
    for (const awareness of this.filenameToSubdocAwareness.values()) {
      awareness.setLocalStateField('user', user)
    }
  }

  setCurrentFile(filename: string | null): void {
    this.awareness.setLocalStateField('currentFile', filename)
  }

  openFile(filename: string): void {
    this.send(encodeMessage(MESSAGE_TYPE_OPEN_FILE, encodeUtf8(filename)))
  }

  getSubdoc(filename: string): Y.Doc | undefined {
    return this.filenameToSubdoc.get(filename) ?? (this.filesMap.get(filename) as Y.Doc | undefined)
  }

  getSubdocAwareness(filename: string): Awareness | undefined {
    return this.filenameToSubdocAwareness.get(filename)
  }

  getAllAwarenessStates(): Map<number, AwarenessClientState> {
    const out = new Map<number, AwarenessClientState>()
    this.awareness.getStates().forEach((state, clientId) => {
      out.set(clientId, state as AwarenessClientState)
    })
    return out
  }

  getSubdocAwarenessStates(filename: string): Map<number, AwarenessClientState> {
    const awareness = this.filenameToSubdocAwareness.get(filename)
    if (!awareness) return new Map()
    const out = new Map<number, AwarenessClientState>()
    awareness.getStates().forEach((state, clientId) => {
      out.set(clientId, state as AwarenessClientState)
    })
    return out
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close()
    }
  }

  // ---- Internals ------------------------------------------------------------

  private send(frame: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      // The browser WebSocket types disagree with `Uint8Array<ArrayBufferLike>`
      // under strict TS; copy into a fresh ArrayBuffer-backed view to satisfy
      // them while keeping our wire helpers working with shared buffers.
      const copy = new Uint8Array(frame.length)
      copy.set(frame)
      this.ws.send(copy)
    }
  }

  private handleRootAwarenessUpdate = ({
    added,
    updated,
    removed,
  }: {
    added: number[]
    updated: number[]
    removed: number[]
  }): void => {
    const changed = Array.from(new Set([...added, ...updated, ...removed]))
    if (changed.length > 0) {
      const update = encodeAwarenessUpdate(this.awareness, changed)
      if (update.length > 0) {
        this.send(encodeMessage(MESSAGE_TYPE_AWARENESS, update))
      }
    }
    this.callbacks.onAwarenessUpdate?.()
  }

  private handleOpen(): void {
    // Announce ourselves in awareness so peers see us right away.
    const update = encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])
    if (update.length > 0) {
      this.send(encodeMessage(MESSAGE_TYPE_AWARENESS, update))
    }
  }

  private handleClose(): void {
    this.awareness.setLocalState(null)
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const data =
      event.data instanceof Blob ? await event.data.arrayBuffer() : (event.data as ArrayBuffer)
    const bytes = toUint8(data)
    if (bytes.length === 0) return

    const messageType = bytes[0]
    const content = bytes.subarray(1)

    if (messageType === MESSAGE_TYPE_SYNC) {
      Y.applyUpdate(this.rootDoc, content)
      return
    }
    if (messageType === MESSAGE_TYPE_AWARENESS) {
      applyAwarenessUpdate(this.awareness, content, null)
      this.callbacks.onAwarenessUpdate?.()
      return
    }
    if (messageType === MESSAGE_TYPE_FILE_LIST) {
      try {
        const files = JSON.parse(decodeUtf8(content)) as string[]
        this.callbacks.onFileListUpdate(files)
      } catch (error) {
        console.error('marky: failed to parse file list', error)
      }
      return
    }
    if (messageType === MESSAGE_TYPE_SUBDOC_SYNC) {
      const { filename, payload } = decodeFileMessage(content)
      let subdoc = this.filenameToSubdoc.get(filename)
      if (!subdoc) {
        subdoc = this.filesMap.get(filename) as Y.Doc | undefined
        if (subdoc) {
          subdoc.load()
          this.registerSubdoc(filename, subdoc)
        }
      }
      if (subdoc) {
        Y.applyUpdate(subdoc, payload)
        this.callbacks.onSubdocUpdate(filename, subdoc)
      }
      return
    }
    if (messageType === MESSAGE_TYPE_SUBDOC_AWARENESS) {
      const { filename, payload } = decodeFileMessage(content)
      const awareness = this.filenameToSubdocAwareness.get(filename)
      if (awareness) {
        applyAwarenessUpdate(awareness, payload, null)
        this.callbacks.onSubdocAwarenessUpdate?.(filename)
      }
      return
    }
  }

  private registerSubdoc(filename: string, subdoc: Y.Doc): void {
    if (this.filenameToSubdoc.has(filename)) return
    this.filenameToSubdoc.set(filename, subdoc)

    const awareness = new Awareness(subdoc)
    this.filenameToSubdocAwareness.set(filename, awareness)

    const localUser = this.awareness.getLocalState()?.user
    if (localUser) awareness.setLocalStateField('user', localUser)

    awareness.on(
      'update',
      ({
        added,
        updated,
        removed,
      }: {
        added: number[]
        updated: number[]
        removed: number[]
      }) => {
        const changed = Array.from(new Set([...added, ...updated, ...removed]))
        if (changed.length > 0) {
          const update = encodeAwarenessUpdate(awareness, changed)
          if (update.length > 0) {
            this.send(encodeFileMessage(MESSAGE_TYPE_SUBDOC_AWARENESS, filename, update))
          }
        }
        this.callbacks.onSubdocAwarenessUpdate?.(filename)
      },
    )

    subdoc.on('update', (update: Uint8Array, origin: unknown) => {
      // Only forward updates that originated locally. Updates we just pulled
      // from the network arrived with origin=null and would echo back if we
      // re-sent them.
      if (origin === null || origin === subdoc) return
      this.send(encodeFileMessage(MESSAGE_TYPE_SUBDOC_SYNC, filename, update))
    })
  }
}
