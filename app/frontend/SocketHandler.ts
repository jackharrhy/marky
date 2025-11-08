import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import {
  MESSAGE_TYPE_SYNC,
  MESSAGE_TYPE_AWARENESS,
  MESSAGE_TYPE_FILE_LIST,
  MESSAGE_TYPE_OPEN_FILE,
  MESSAGE_TYPE_PERSIST_FILE,
  MESSAGE_TYPE_SUBDOC_SYNC,
  MESSAGE_TYPE_SUBDOC_AWARENESS,
} from "../shared/message-types.js";
import { log } from "../shared/log.js";

export interface SocketHandlerCallbacks {
  onFileListUpdate: (files: string[]) => void;
  onFileOpened: (filename: string, subdoc: Y.Doc) => void;
  onSubdocUpdate: (filename: string, subdoc: Y.Doc) => void;
  onAwarenessUpdate?: () => void;
  onSubdocAwarenessUpdate?: (filename: string) => void;
}

export class SocketHandler {
  private rootDoc: Y.Doc;
  private filesMap: Y.Map<Y.Doc>;
  private awareness: Awareness; // Root awareness for file tracking
  private ws: WebSocket;
  private callbacks: SocketHandlerCallbacks;
  private filenameToSubdoc: Map<string, Y.Doc> = new Map();
  private filenameToSubdocAwareness: Map<string, Awareness> = new Map();

  constructor(callbacks: SocketHandlerCallbacks) {
    this.callbacks = callbacks;
    this.rootDoc = new Y.Doc();
    this.filesMap = this.rootDoc.getMap("files");

    this.awareness = new Awareness(this.rootDoc);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => this.handleWebSocketOpen();
    this.ws.onerror = (error) => this.handleWebSocketError(error);
    this.ws.onclose = () => this.handleWebSocketClose();
    this.ws.onmessage = (event) => this.handleWebSocketMessage(event);

    // Handle root doc updates
    this.rootDoc.on("update", (update: Uint8Array) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        const message = new Uint8Array(1 + update.length);
        message[0] = MESSAGE_TYPE_SYNC;
        message.set(update, 1);
        this.ws.send(message);
      }
    });

    // Handle awareness updates
    this.awareness.on(
      "update",
      ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        if (this.ws.readyState === WebSocket.OPEN) {
          const changedClients = Array.from(
            new Set([...added, ...updated, ...removed])
          );
          if (changedClients.length > 0) {
            const awarenessUpdate = encodeAwarenessUpdate(
              this.awareness,
              changedClients
            );
            if (awarenessUpdate.length > 0) {
              const message = new Uint8Array(1 + awarenessUpdate.length);
              message[0] = MESSAGE_TYPE_AWARENESS;
              message.set(awarenessUpdate, 1);
              this.ws.send(message);
            }
          }
        }
        // Notify callback of awareness changes
        if (this.callbacks.onAwarenessUpdate) {
          this.callbacks.onAwarenessUpdate();
        }
      }
    );

    // Handle subdocs event
    this.rootDoc.on("subdocs", ({ added, removed, loaded }) => {
      loaded.forEach((subdoc) => {
        // Find which file this subdoc belongs to
        this.filesMap.forEach((doc, filename) => {
          if (doc === subdoc) {
            this.filenameToSubdoc.set(filename, subdoc);

            // Set up awareness for this subdoc
            this.setupSubdocAwareness(filename, subdoc);

            // Set up update handler for this subdoc
            subdoc.on("update", (update: Uint8Array, origin: unknown) => {
              // Don't send updates that originate from the subdoc itself (local initialization)
              // Only send updates from user edits (which come from y-prosemirror)
              if (origin !== subdoc) {
                this.sendSubdocUpdate(filename, update);
              }
            });
            this.callbacks.onFileOpened(filename, subdoc);
          }
        });
      });
    });
  }

  /**
   * Set up awareness for a subdoc - extracted to avoid duplication
   */
  private setupSubdocAwareness(filename: string, subdoc: Y.Doc): void {
    if (this.filenameToSubdocAwareness.has(filename)) {
      return; // Already set up
    }

    const subdocAwareness = new Awareness(subdoc);
    this.filenameToSubdocAwareness.set(filename, subdocAwareness);

    // Set up awareness update handler for this subdoc
    subdocAwareness.on(
      "update",
      ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        if (this.ws.readyState === WebSocket.OPEN) {
          const changedClients = Array.from(
            new Set([...added, ...updated, ...removed])
          );
          if (changedClients.length > 0) {
            const awarenessUpdate = encodeAwarenessUpdate(
              subdocAwareness,
              changedClients
            );
            if (awarenessUpdate.length > 0) {
              this.sendSubdocAwarenessUpdate(filename, awarenessUpdate);
            }
          }
        }
        // Notify callback of subdoc awareness changes
        if (this.callbacks.onSubdocAwarenessUpdate) {
          this.callbacks.onSubdocAwarenessUpdate(filename);
        }
      }
    );

    // Set user info in subdoc awareness
    const currentState = this.awareness.getLocalState();
    if (currentState && currentState.user) {
      subdocAwareness.setLocalStateField("user", currentState.user);
    }
  }

  setAwarenessState(user: { name: string; color: string }) {
    this.awareness.setLocalStateField("user", user);
    // Also set user info in all subdoc awareness instances
    this.filenameToSubdocAwareness.forEach((subdocAwareness) => {
      subdocAwareness.setLocalStateField("user", user);
    });
  }

  setCurrentFile(filename: string | null) {
    this.awareness.setLocalStateField("currentFile", filename);
  }

  getAllAwarenessStates(): Map<
    number,
    { user?: { name: string; color: string }; currentFile?: string | null }
  > {
    const states = new Map();
    this.awareness.getStates().forEach((state, clientId) => {
      states.set(clientId, state);
    });
    return states;
  }

  private handleWebSocketOpen() {
    log.info("WebSocket connected");
    const awarenessUpdate = encodeAwarenessUpdate(this.awareness, [
      this.awareness.clientID,
    ]);
    if (awarenessUpdate.length > 0) {
      const message = new Uint8Array(1 + awarenessUpdate.length);
      message[0] = MESSAGE_TYPE_AWARENESS;
      message.set(awarenessUpdate, 1);
      this.ws.send(message);
    }
  }

  private handleWebSocketError(error: Event) {
    log.error("WebSocket error:", error);
  }

  private handleWebSocketClose() {
    log.info("WebSocket disconnected");
    this.awareness.setLocalState(null);
  }

  private async handleWebSocketMessage(event: MessageEvent) {
    let data: ArrayBuffer;

    if (event.data instanceof Blob) {
      data = await event.data.arrayBuffer();
    } else if (event.data instanceof ArrayBuffer) {
      data = event.data;
    } else {
      log.warn("received message is neither Blob nor ArrayBuffer", {
        data: event.data,
      });
      return;
    }

    const message = new Uint8Array(data);
    if (message.length === 0) {
      log.warn("received message is empty", { message });
      return;
    }

    const messageType = message[0];
    const content = message.slice(1);

    if (messageType === MESSAGE_TYPE_SYNC) {
      Y.applyUpdate(this.rootDoc, content);
    } else if (messageType === MESSAGE_TYPE_AWARENESS) {
      applyAwarenessUpdate(this.awareness, content, null);
      // Notify callback of awareness changes
      if (this.callbacks.onAwarenessUpdate) {
        this.callbacks.onAwarenessUpdate();
      }
    } else if (messageType === MESSAGE_TYPE_FILE_LIST) {
      try {
        const files = JSON.parse(new TextDecoder().decode(content)) as string[];
        this.callbacks.onFileListUpdate(files);
      } catch (error) {
        log.error("Error parsing file list:", error);
      }
    } else if (messageType === MESSAGE_TYPE_SUBDOC_SYNC) {
      try {
        // Format: [filenameLength (1 byte)][filename][update]
        const filenameLength = content[0];
        const filename = new TextDecoder().decode(
          content.slice(1, 1 + filenameLength)
        );
        const update = content.slice(1 + filenameLength);

        let subdoc = this.filenameToSubdoc.get(filename);
        if (!subdoc) {
          // Get subdoc from filesMap
          subdoc = this.filesMap.get(filename) as Y.Doc;
          if (subdoc) {
            this.filenameToSubdoc.set(filename, subdoc);
            subdoc.load();

            // Set up awareness for this subdoc
            this.setupSubdocAwareness(filename, subdoc);

            // Set up update handler
            subdoc.on("update", (update: Uint8Array, origin: unknown) => {
              // Don't send updates that originate from the subdoc itself (local initialization)
              // Only send updates from user edits (which come from y-prosemirror)
              if (origin !== subdoc) {
                this.sendSubdocUpdate(filename, update);
              }
            });
          }
        }

        if (subdoc) {
          Y.applyUpdate(subdoc, update);
          this.callbacks.onSubdocUpdate(filename, subdoc);
        }
      } catch (error) {
        log.error("Error handling subdoc sync:", error);
      }
    } else if (messageType === MESSAGE_TYPE_SUBDOC_AWARENESS) {
      try {
        // Format: [filenameLength (1 byte)][filename][awarenessUpdate]
        const filenameLength = content[0];
        const filename = new TextDecoder().decode(
          content.slice(1, 1 + filenameLength)
        );
        const awarenessUpdate = content.slice(1 + filenameLength);

        const subdocAwareness = this.filenameToSubdocAwareness.get(filename);
        if (subdocAwareness) {
          applyAwarenessUpdate(subdocAwareness, awarenessUpdate, null);
          // Notify callback of subdoc awareness changes
          if (this.callbacks.onSubdocAwarenessUpdate) {
            this.callbacks.onSubdocAwarenessUpdate(filename);
          }
        }
      } catch (error) {
        log.error("Error handling subdoc awareness:", error);
      }
    }
  }

  private sendSubdocUpdate(filename: string, update: Uint8Array) {
    if (this.ws.readyState === WebSocket.OPEN) {
      const filenameBuf = new TextEncoder().encode(filename);
      const message = new Uint8Array(
        1 + 1 + filenameBuf.length + update.length
      );
      message[0] = MESSAGE_TYPE_SUBDOC_SYNC;
      message[1] = filenameBuf.length;
      message.set(filenameBuf, 2);
      message.set(update, 2 + filenameBuf.length);
      this.ws.send(message);
    }
  }

  openFile(filename: string) {
    log.info("SocketHandler.openFile called with:", filename);
    log.info("WebSocket readyState:", this.ws.readyState);
    const message = new TextEncoder().encode(filename);
    const fullMessage = new Uint8Array(1 + message.length);
    fullMessage[0] = MESSAGE_TYPE_OPEN_FILE;
    fullMessage.set(message, 1);
    log.info("Sending openFile message, length:", fullMessage.length);
    this.ws.send(fullMessage);
    log.info("Message sent");
  }

  persistFile(filename: string) {
    const message = new TextEncoder().encode(filename);
    const fullMessage = new Uint8Array(1 + message.length);
    fullMessage[0] = MESSAGE_TYPE_PERSIST_FILE;
    fullMessage.set(message, 1);
    this.ws.send(fullMessage);
  }

  getSubdoc(filename: string): Y.Doc | undefined {
    return (
      this.filenameToSubdoc.get(filename) ||
      (this.filesMap.get(filename) as Y.Doc)
    );
  }

  getAwareness(): Awareness {
    return this.awareness;
  }

  getSubdocAwareness(filename: string): Awareness | undefined {
    return this.filenameToSubdocAwareness.get(filename);
  }

  getAllSubdocAwarenessStates(
    filename: string
  ): Map<number, { user?: { name: string; color: string } }> {
    const subdocAwareness = this.filenameToSubdocAwareness.get(filename);
    if (!subdocAwareness) {
      return new Map();
    }
    const states = new Map();
    subdocAwareness.getStates().forEach((state, clientId) => {
      states.set(clientId, state);
    });
    return states;
  }

  private sendSubdocAwarenessUpdate(
    filename: string,
    awarenessUpdate: Uint8Array
  ) {
    if (this.ws.readyState === WebSocket.OPEN) {
      const filenameBuf = new TextEncoder().encode(filename);
      const message = new Uint8Array(
        1 + 1 + filenameBuf.length + awarenessUpdate.length
      );
      message[0] = MESSAGE_TYPE_SUBDOC_AWARENESS;
      message[1] = filenameBuf.length;
      message.set(filenameBuf, 2);
      message.set(awarenessUpdate, 2 + filenameBuf.length);
      this.ws.send(message);
    }
  }
}
