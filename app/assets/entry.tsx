import { createRoot, connect, type Remix } from "@remix-run/dom";
import { CollaborativeEditor } from "../utils/CollaborativeEditor";

function App(this: Remix.Handle) {
  const editor = new CollaborativeEditor({
    name: "Jack",
    color: "#3b82f6",
  });

  return () => (
    <>
      <div className="editor-wrapper">
        <h1>marky</h1>
        <div
          className="editor-container"
          on={[
            connect((event) => {
              editor.handleEditorConnect(event);
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
