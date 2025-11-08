import { createRoot, connect, type Remix } from "@remix-run/dom";
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

import "./style.css";
import "./cursors.css";
import "prosemirror-view/style/prosemirror.css";

const MESSAGE_TYPE_SYNC = 0;
const MESSAGE_TYPE_AWARENESS = 1;

function App(this: Remix.Handle) {
  const ydoc = new Y.Doc();
  const type = ydoc.getXmlFragment("prosemirror");

  const awareness = new Awareness(ydoc);
  const clientId = Math.random().toString(36).substring(2, 15);
  awareness.setLocalStateField("user", {
    name: `User ${clientId.substring(0, 6)}`,
    color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
  });

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WebSocket connected");
    const awarenessUpdate = encodeAwarenessUpdate(awareness, [
      awareness.clientID,
    ]);
    if (awarenessUpdate.length > 0) {
      const message = new Uint8Array(1 + awarenessUpdate.length);
      message[0] = MESSAGE_TYPE_AWARENESS;
      message.set(awarenessUpdate, 1);
      ws.send(message);
    }
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
  };

  ws.onclose = () => {
    console.log("WebSocket disconnected");
    awareness.setLocalState(null);
  };

  ws.onmessage = async (event: MessageEvent) => {
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
      Y.applyUpdate(ydoc, content);
    } else if (messageType === MESSAGE_TYPE_AWARENESS) {
      applyAwarenessUpdate(awareness, content, null);
    }
  };

  ydoc.on("update", (update: Uint8Array) => {
    if (ws.readyState === WebSocket.OPEN) {
      const message = new Uint8Array(1 + update.length);
      message[0] = MESSAGE_TYPE_SYNC;
      message.set(update, 1);
      console.info("sending update", { message });
      ws.send(message);
    } else {
      console.warn("WebSocket not open, dropping update");
    }
  });

  awareness.on(
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
      if (ws.readyState === WebSocket.OPEN) {
        const changedClients = Array.from(
          new Set([...added, ...updated, ...removed])
        );
        if (changedClients.length > 0) {
          const awarenessUpdate = encodeAwarenessUpdate(
            awareness,
            changedClients
          );
          if (awarenessUpdate.length > 0) {
            const message = new Uint8Array(1 + awarenessUpdate.length);
            message[0] = MESSAGE_TYPE_AWARENESS;
            message.set(awarenessUpdate, 1);
            ws.send(message);
          }
        }
      }
    }
  );

  const editorState = EditorState.create({
    schema,
    plugins: [
      ySyncPlugin(type),
      yUndoPlugin(),
      yCursorPlugin(awareness),
      keymap(baseKeymap),
    ],
  });

  let view: EditorView | null = null;

  return () => (
    <>
      <div className="editor-wrapper">
        <h1>marky</h1>
        <div
          className="editor-container"
          on={[
            connect((event) => {
              const el = event.currentTarget;
              if (!view) {
                view = new EditorView(el, {
                  state: editorState,
                  dispatchTransaction(transaction) {
                    if (view) {
                      const newState = view.state.apply(transaction);
                      view.updateState(newState);
                    }
                  },
                });
              }
            }),
          ]}
        />
      </div>
    </>
  );
}

const rootEl = document.getElementById("root");

if (!rootEl) {
  throw new Error("Root element not found");
}

createRoot(rootEl).render(<App />);
