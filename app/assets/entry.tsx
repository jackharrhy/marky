import { createRoot, connect, type Remix } from "@remix-run/dom";
import * as Y from "yjs";
import { ySyncPlugin, yUndoPlugin } from "y-prosemirror";
import { schema } from "prosemirror-schema-basic";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import "./style.css";
import "prosemirror-view/style/prosemirror.css";

const MESSAGE_TYPE_SYNC = 0;

function App(this: Remix.Handle) {
  const ydoc = new Y.Doc();
  const type = ydoc.getXmlFragment("prosemirror");

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WebSocket connected");
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
  };

  ws.onclose = () => {
    console.log("WebSocket disconnected");
  };

  ws.onmessage = async (event: MessageEvent) => {
    console.log("received message", { event });
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

    console.log({ messageType, content });

    if (messageType === MESSAGE_TYPE_SYNC) {
      Y.applyUpdate(ydoc, content);
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

  const editorState = EditorState.create({
    schema,
    plugins: [ySyncPlugin(type), yUndoPlugin()],
  });

  let view: EditorView | null = null;

  return () => (
    <>
      <div className="editor-wrapper">
        <h1>Collaborative Editor</h1>
        <div
          className="editor-container"
          on={[
            connect((event) => {
              const el = event.currentTarget;
              if (!view) {
                // Create editor view when element connects to DOM
                view = new EditorView(el, {
                  state: editorState,
                  dispatchTransaction(transaction) {
                    if (view) {
                      const newState = view.state.apply(transaction);
                      view.updateState(newState);
                    }
                  },
                });
                console.log({ view });
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
