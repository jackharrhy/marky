import { createRoot, connect, type Remix } from "@remix-run/dom";
import { on } from "@remix-run/interaction";
import { CollaborativeEditor } from "../frontend/CollaborativeEditor";
import { SocketHandler } from "../frontend/SocketHandler";
import { getUser } from "../frontend/utils";
import * as Y from "yjs";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { plainTextSchema } from "../frontend/schema";

// Helper to convert ProseMirror doc to plain text string (for persist)
function docToText(doc: ReturnType<typeof plainTextSchema.node>): string {
  const paragraphs: string[] = [];
  doc.forEach((node) => {
    if (node.type.name === "paragraph") {
      paragraphs.push(node.textContent);
    }
  });
  return paragraphs.join("\n");
}

function App(this: Remix.Handle) {
  const user = getUser();

  let socketHandler: SocketHandler | null = null;
  let editor: CollaborativeEditor | null = null;
  let currentFilename: string | null = null;
  let files: string[] = [];
  let editorElement: HTMLElement | null = null;
  let newFileInput: HTMLInputElement | null = null;
  let editorSetupForFile: string | null = null; // Track which file the editor is set up for
  let persistButtonText: string = "Persist";
  let awarenessStates: Map<
    number,
    { user?: { name: string; color: string }; currentFile?: string | null }
  > = new Map();
  let updateFn: (() => void) | null = null;

  const handleAwarenessUpdate = () => {
    if (!socketHandler) return;
    awarenessStates = socketHandler.getAllAwarenessStates();
    // Use stored update function if available
    if (updateFn) {
      updateFn();
    }
  };

  const handleSubdocAwarenessUpdate = (filename: string) => {
    // If this is the current file, try to set up editor if not already set up
    if (filename === currentFilename && socketHandler) {
      const subdoc = socketHandler.getSubdoc(filename);
      if (subdoc && editorSetupForFile !== filename) {
        setupEditor(subdoc, filename);
      }
    }
    // Trigger re-render to update user indicators
    if (updateFn) {
      updateFn();
    }
  };

  // Get users viewing a specific file
  const getUsersViewingFile = (filename: string) => {
    const users: { name: string; color: string }[] = [];
    awarenessStates.forEach((state) => {
      if (state.currentFile === filename && state.user) {
        users.push(state.user);
      }
    });
    return users;
  };

  // Get users in current subdoc (those viewing the same file)
  const getUsersInCurrentSubdoc = () => {
    if (!currentFilename || !socketHandler) return [];
    const subdocAwarenessStates =
      socketHandler.getAllSubdocAwarenessStates(currentFilename);
    const users: { name: string; color: string }[] = [];
    subdocAwarenessStates.forEach((state) => {
      if (state.user) {
        users.push(state.user);
      }
    });
    return users;
  };

  const handleFileListUpdate = (fileList: string[]) => {
    console.log(
      `handleFileListUpdate called with file list of ${fileList.length} files`
    );
    files = fileList;
    this.update(); // Trigger re-render
  };

  const openFile = (filename: string) => {
    console.log("openFile called with:", filename);
    if (!socketHandler) {
      console.log("Early return: no socketHandler");
      return;
    }

    console.log("Setting currentFilename to:", filename);
    currentFilename = filename;
    editorSetupForFile = null; // Reset so editor will be set up for new file

    // Update awareness state with current file
    socketHandler.setCurrentFile(filename);

    this.update(); // Trigger re-render to update active file highlight

    // Request to open file - editor will be set up when content arrives via handleFileOpened
    console.log("Calling socketHandler.openFile");
    socketHandler.openFile(filename);
  };

  const setupEditor = (subdoc: Y.Doc, filename: string) => {
    if (!socketHandler) return;

    // Only set up editor if this is a different file or editor isn't set up yet
    if (editorSetupForFile === filename && editor) {
      return; // Already set up for this file
    }

    // Get subdoc-specific awareness (create if needed)
    let subdocAwareness = socketHandler.getSubdocAwareness(filename);
    if (!subdocAwareness) {
      // Awareness will be created when subdoc loads, wait for it
      console.log(
        "Subdoc awareness not yet available, will be created on subdoc load"
      );
      return;
    }

    if (editor) {
      // If editor exists, switch to new subdoc and awareness
      console.log("Switching editor to new subdoc");
      editor.switchToSubdoc(subdoc, subdocAwareness);
    } else {
      // Create new editor - backend has already populated XmlFragment
      console.log("Creating new editor");
      editor = new CollaborativeEditor({
        subdoc,
        awareness: subdocAwareness,
      });
    }

    editorSetupForFile = filename; // Track that we've set up for this file

    // Mount editor to element if it exists
    if (editorElement) {
      console.log("Mounting editor to element");
      editor.mount(editorElement);
    } else {
      console.log(
        "Editor element not available yet, will mount on element connect"
      );
    }
  };

  const handleFileOpened = (filename: string, subdoc: Y.Doc) => {
    // Don't set up editor here - wait for content to arrive via handleSubdocUpdate
    // This callback just indicates the subdoc is available, not that content is loaded
    console.log("File opened (subdoc available):", filename);
  };

  const handleSubdocUpdate = (filename: string, subdoc: Y.Doc) => {
    console.log("handleSubdocUpdate called for:", filename);
    // Only set up editor when we receive a subdoc update for the current file
    // and editor isn't already set up for this file
    if (filename === currentFilename && editorSetupForFile !== filename) {
      // Check XmlFragment for content - backend has populated it
      const xmlFragment = subdoc.getXmlFragment("prosemirror");
      const doc = yXmlFragmentToProseMirrorRootNode(
        xmlFragment,
        plainTextSchema
      );
      const text = docToText(doc);

      console.log("Content length:", text.length);

      // If server sent us the subdoc update, content is loaded (even if empty)
      // Empty files are valid - set up the editor
      setupEditor(subdoc, filename);
    }
  };

  const handlePersist = () => {
    if (!currentFilename || !socketHandler || !editor) return;

    // Get content from editor and convert to text for server
    const state = editor.getState();
    const text = docToText(state.doc);

    // Send persist request - server will read from XmlFragment directly
    // (ySyncPlugin has already synced editor changes to XmlFragment)
    socketHandler.persistFile(currentFilename);

    // Update button text to show feedback
    persistButtonText = "Persisted";
    this.update();

    // Reset button text after 5 seconds
    setTimeout(() => {
      persistButtonText = "Persist";
      this.update();
    }, 5000);
  };

  const handleNewFile = () => {
    console.log("handleNewFile called");
    console.log("newFileInput:", newFileInput);
    console.log("socketHandler:", socketHandler);

    if (!newFileInput || !socketHandler) {
      console.log("Early return: missing newFileInput or socketHandler");
      return;
    }

    const filename = newFileInput.value.trim();
    console.log("Input value:", filename);

    if (!filename) {
      console.log("Early return: empty filename");
      return;
    }

    const fullFilename = filename.endsWith(".md") ? filename : `${filename}.md`;
    console.log("Opening file:", fullFilename);

    // Create new file by opening it
    openFile(fullFilename);

    // Clear input
    newFileInput.value = "";
    console.log("Input cleared");
  };

  // Initialize socket handler (only once)
  if (!socketHandler) {
    socketHandler = new SocketHandler({
      onFileListUpdate: handleFileListUpdate,
      onFileOpened: handleFileOpened,
      onSubdocUpdate: handleSubdocUpdate,
      onAwarenessUpdate: handleAwarenessUpdate,
      onSubdocAwarenessUpdate: handleSubdocAwarenessUpdate,
    });

    socketHandler.setAwarenessState({
      name: user.name,
      color: user.color,
    });

    // Initialize awareness states
    awarenessStates = socketHandler.getAllAwarenessStates();
  }

  // Store update function reference for awareness updates
  updateFn = this.update.bind(this);

  return () => (
    <div className="flex flex-col h-full">
      {/* Navbar */}
      <div className="border-b border-base-200 px-4 py-3">
        <h1 className="font-bold text-center">marky</h1>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-64 border-r border-base-200 flex flex-col">
          <div className="p-4">
            <h2 className="font-bold mb-4">Files</h2>
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="New file name"
                className="flex-1 min-w-0 px-2 py-1 border border-base-300 rounded text-sm"
                on={[
                  connect((event) => {
                    console.log("Input connect callback called");
                    newFileInput = event.currentTarget as HTMLInputElement;
                    on(event.currentTarget, {
                      keydown: (e: KeyboardEvent) => {
                        if (e.key === "Enter") {
                          console.log("Enter key pressed in input");
                          handleNewFile();
                        }
                      },
                    });
                  }),
                ]}
              />
              <button
                className="px-3 py-1 bg-base-200 hover:bg-base-300 rounded text-sm"
                on={[
                  connect((event) => {
                    console.log("Button connect callback called");
                    on(event.currentTarget, {
                      click: () => {
                        console.log("Button clicked!");
                        handleNewFile();
                      },
                    });
                  }),
                ]}
              >
                New
              </button>
            </div>
          </div>
          <ul className="flex-1 overflow-y-auto px-4 pb-4">
            {files.map((file) => {
              const displayName = file.replace(/\.md$/, "");
              const usersViewing = getUsersViewingFile(file);
              return (
                <li
                  key={file}
                  className={`cursor-pointer p-2 hover:bg-base-100 rounded flex items-center justify-between ${
                    file === currentFilename ? "bg-base-200" : ""
                  }`}
                  on={[
                    connect((event) => {
                      on(event.currentTarget, {
                        click: () => {
                          openFile(file);
                        },
                      });
                    }),
                  ]}
                >
                  <span>{displayName}</span>
                  {usersViewing.length > 0 && (
                    <div className="flex gap-1 ml-2">
                      {usersViewing.map((user, idx) => (
                        <div
                          key={idx}
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: user.color }}
                          title={user.name}
                        />
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Main content */}
        <div className="flex-1 flex flex-col">
          {/* Filename bar */}
          {currentFilename && (
            <div className="border-b border-base-200 px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-sm text-base-600">
                  {currentFilename.replace(/\.md$/, "")}
                </span>
                {getUsersInCurrentSubdoc().length > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      {getUsersInCurrentSubdoc().map((user, idx) => (
                        <div
                          key={idx}
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: user.color }}
                          title={user.name}
                        />
                      ))}
                    </div>
                    <span className="text-xs text-base-500">
                      {getUsersInCurrentSubdoc()
                        .map((u) => u.name)
                        .join(", ")}
                    </span>
                  </div>
                )}
              </div>
              <button
                className="px-4 py-1 bg-base-200 hover:bg-base-300 rounded text-sm"
                on={[
                  connect((event) => {
                    on(event.currentTarget, {
                      click: () => {
                        handlePersist();
                      },
                    });
                  }),
                ]}
              >
                {persistButtonText}
              </button>
            </div>
          )}
          <div
            className="flex-1 p-4 overflow-auto"
            on={[
              connect((event) => {
                console.log("Editor element connected");
                editorElement = event.currentTarget;
                if (editor) {
                  console.log("Mounting existing editor");
                  editor.mount(editorElement);
                } else if (currentFilename && socketHandler) {
                  // If we have a file open but no editor yet, set it up
                  console.log(
                    "Setting up editor for current file:",
                    currentFilename
                  );
                  const subdoc = socketHandler.getSubdoc(currentFilename);
                  if (subdoc) {
                    // setupEditor will mount since editorElement is now set
                    setupEditor(subdoc, currentFilename);
                  }
                }
              }),
            ]}
          />
        </div>
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");

if (!rootEl) {
  throw new Error("Root element not found");
}

createRoot(rootEl).render(<App />);
