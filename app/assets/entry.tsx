import { createRoot, type Remix } from "@remix-run/dom";

import "./style.css";

function App(this: Remix.Handle) {
  return () => {
    return (
      <>
        <h1>Hello, world!</h1>
      </>
    );
  };
}

const rootEl = document.getElementById("root");

if (!rootEl) {
  throw new Error("Root element not found");
}

createRoot(rootEl).render(<App />);
