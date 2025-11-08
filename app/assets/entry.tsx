import { createRoot, connect, type Remix } from "@remix-run/dom";
import { CollaborativeEditor } from "../utils/CollaborativeEditor";

const welshFlowers = [
  "Daffodil",
  "Leek",
  "Bluebell",
  "Primrose",
  "Foxglove",
  "Buttercup",
  "Clover",
  "Heather",
  "Gorse",
  "Hawthorn",
  "Blackthorn",
  "Wild Rose",
  "Violet",
  "Snowdrop",
  "Poppy",
  "Thistle",
  "Lily",
  "Dandelion",
  "Honeysuckle",
  "Fern",
  "Cornflower",
];

function pickRandomColor() {
  const rootStyles = getComputedStyle(document.documentElement);
  const colorVars = [
    "--color-blue-500",
    "--color-blue-600",
    "--color-cyan-600",
    "--color-green-500",
    "--color-green-600",
    "--color-yellow-600",
    "--color-orange-600",
    "--color-red-600",
    "--color-purple-600",
    "--color-magenta-600",
  ];
  const colors = colorVars
    .map((v) => rootStyles.getPropertyValue(v).trim())
    .filter(Boolean);
  if (!colors.length) return "red";
  const idx = Math.floor(Math.random() * colors.length);
  return colors[idx];
}

function getUser(): { name: string; color: string } {
  const stored = localStorage.getItem("user");
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      console.error(
        "Failed to parse user from localStorage, falling back to default"
      );
    }
  }

  const randomName =
    welshFlowers[Math.floor(Math.random() * welshFlowers.length)];

  return { name: `Anonymous ${randomName}`, color: pickRandomColor() };
}

function App(this: Remix.Handle) {
  const user = getUser();

  const editor = new CollaborativeEditor({
    name: user.name,
    color: user.color,
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
