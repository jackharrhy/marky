import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { ySyncPlugin, yUndoPlugin, yCursorPlugin } from "y-prosemirror";
import { schema } from "prosemirror-schema-basic";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";

const MESSAGE_TYPE_SYNC = 0;
const MESSAGE_TYPE_AWARENESS = 1;

export interface CollaborativeEditorOptions {
  name: string;
  color: string;
}

export class CollaborativeEditor {
  private ydoc: Y.Doc;
  private type: Y.XmlFragment;
  private awareness: Awareness;
  private ws: WebSocket;
  private editorState: EditorState;
  private view: EditorView | null = null;

  constructor(options: CollaborativeEditorOptions) {
    this.ydoc = new Y.Doc();
    this.type = this.ydoc.getXmlFragment("prosemirror");

    this.awareness = new Awareness(this.ydoc);
    this.awareness.setLocalStateField("user", {
      name: options.name,
      color: options.color,
    });

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => this.handleWebSocketOpen();
    this.ws.onerror = (error) => this.handleWebSocketError(error);
    this.ws.onclose = () => this.handleWebSocketClose();
    this.ws.onmessage = (event) => this.handleWebSocketMessage(event);

    this.ydoc.on("update", (update: Uint8Array) =>
      this.handleYdocUpdate(update)
    );

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
      }) => this.handleAwarenessUpdate({ added, updated, removed })
    );

    this.editorState = EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(this.type),
        yUndoPlugin(),
        yCursorPlugin(this.awareness),
        keymap(baseKeymap),
      ],
    });
  }

  private handleWebSocketOpen() {
    console.log("WebSocket connected");
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
    console.error("WebSocket error:", error);
  }

  private handleWebSocketClose() {
    console.log("WebSocket disconnected");
    this.awareness.setLocalState(null);
  }

  private async handleWebSocketMessage(event: MessageEvent) {
    let data: ArrayBuffer;

    if (event.data instanceof Blob) {
      data = await event.data.arrayBuffer();
    } else if (event.data instanceof ArrayBuffer) {
      data = event.data;
    } else {
      console.warn("received message is neither Blob nor ArrayBuffer", {
        data: event.data,
      });
      return;
    }

    const message = new Uint8Array(data);
    if (message.length === 0) {
      console.warn("received message is empty", { message });
      return;
    }

    const messageType = message[0];
    const content = message.slice(1);

    if (messageType === MESSAGE_TYPE_SYNC) {
      Y.applyUpdate(this.ydoc, content);
    } else if (messageType === MESSAGE_TYPE_AWARENESS) {
      applyAwarenessUpdate(this.awareness, content, null);
    }
  }

  private handleYdocUpdate(update: Uint8Array) {
    if (this.ws.readyState === WebSocket.OPEN) {
      const message = new Uint8Array(1 + update.length);
      message[0] = MESSAGE_TYPE_SYNC;
      message.set(update, 1);
      console.info("sending update", { message });
      this.ws.send(message);
    } else {
      console.warn("WebSocket not open, dropping update");
    }
  }

  private handleAwarenessUpdate({
    added,
    updated,
    removed,
  }: {
    added: number[];
    updated: number[];
    removed: number[];
  }) {
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
  }

  handleEditorConnect(event: Event) {
    const el = event.currentTarget as HTMLElement;
    if (!this.view) {
      this.view = new EditorView(el, {
        state: this.editorState,
        dispatchTransaction: (transaction) => {
          if (this.view) {
            const newState = this.view.state.apply(transaction);
            this.view.updateState(newState);
          }
        },
      });
    }
  }
}
