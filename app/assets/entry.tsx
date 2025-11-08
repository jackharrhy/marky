import { createRoot, connect, type Remix } from "@remix-run/dom";
import { CollaborativeEditor } from "../frontend/CollaborativeEditor";
import { getUser } from "../frontend/utils";

function App(this: Remix.Handle) {
  const user = getUser();

  const editor = new CollaborativeEditor({
    name: user.name,
    color: user.color,
  });

  return () => (
    <>
      <h1 className="font-bold text-center">marky</h1>
      <div
        className="p-4 border border-base-200 rounded-lg"
        on={[
          connect((event) => {
            editor.handleEditorConnect(event);
          }),
        ]}
      />
    </>
  );
}

const rootEl = document.getElementById("root");

if (!rootEl) {
  throw new Error("Root element not found");
}

createRoot(rootEl).render(<App />);
