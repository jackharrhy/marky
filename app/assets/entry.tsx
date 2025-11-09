import { createRoot, connect, type Remix } from "@remix-run/dom";
import { on } from "@remix-run/interaction";
import { CollaborativeEditor } from "../frontend/CollaborativeEditor";
import { SocketHandler } from "../frontend/SocketHandler";
import { getUser, type User } from "../frontend/utils";
import * as Y from "yjs";
import debugFactory from "debug";
import { PERSIST_BUTTON_RESET_DELAY_MS } from "../shared/constants";

const debug = debugFactory("marky:assets:entry.tsx");

function App(this: Remix.Handle) {
  const user = getUser();

  let socketHandler: SocketHandler | null = null;
  let editor: CollaborativeEditor | null = null;
  let currentFilename: string | null = null;
  let files: string[] = [];
  let editorElement: HTMLElement | null = null;
  let newFileInput: HTMLInputElement | null = null;
  let editorSetupForFile: string | null = null;
  let persistButtonText: string = "Persist";
  let awarenessStates: Map<
    number,
    { user?: User; currentFile?: string | null }
  > = new Map();

  const handleAwarenessUpdate = () => {
    if (!socketHandler) return;
    awarenessStates = socketHandler.getAllAwarenessStates();
  };

  const handleSubdocAwarenessUpdate = (filename: string) => {
    if (filename === currentFilename && socketHandler) {
      const subdoc = socketHandler.getSubdoc(filename);
      if (subdoc && editorSetupForFile !== filename) {
        setupEditor(subdoc, filename);
      }
    }
  };

  const getUsersViewingFile = (filename: string) => {
    const users: User[] = [];
    awarenessStates.forEach((state) => {
      if (state.currentFile === filename && state.user) {
        users.push(state.user);
      }
    });
    return users;
  };

  const getUsersInCurrentSubdoc = () => {
    if (!currentFilename || !socketHandler) return [];
    const subdocAwarenessStates =
      socketHandler.getAllSubdocAwarenessStates(currentFilename);
    const users: User[] = [];
    subdocAwarenessStates.forEach((state) => {
      if (state.user) {
        users.push(state.user);
      }
    });
    return users;
  };

  const handleFileListUpdate = (fileList: string[]) => {
    debug(
      `handleFileListUpdate called with file list of ${fileList.length} files`
    );
    files = fileList;
    this.update();
  };

  const openFile = (filename: string) => {
    debug("openFile called with:", filename);
    if (!socketHandler) {
      console.error("no socket handler, can't open file");
      return;
    }

    currentFilename = filename;
    editorSetupForFile = null;

    socketHandler.setCurrentFile(filename);
    this.update();
    socketHandler.openFile(filename);
  };

  const setupEditor = (subdoc: Y.Doc, filename: string) => {
    if (!socketHandler) return;

    if (editorSetupForFile === filename && editor) {
      return;
    }

    let subdocAwareness = socketHandler.getSubdocAwareness(filename);
    if (!subdocAwareness) {
      console.warn(
        "Subdoc awareness not yet available, will be created on subdoc load"
      );
      return;
    }

    if (editor) {
      editor.switchToSubdoc(subdoc, subdocAwareness);
    } else {
      editor = new CollaborativeEditor({
        subdoc,
        awareness: subdocAwareness,
      });
    }

    editorSetupForFile = filename;

    if (editorElement) {
      debug("mounting editor to element");
      editor.mount(editorElement);
    } else {
      console.warn(
        "Editor element not available yet, will mount on element connect"
      );
    }
  };

  const handleSubdocUpdate = (filename: string, subdoc: Y.Doc) => {
    if (filename === currentFilename && editorSetupForFile !== filename) {
      setupEditor(subdoc, filename);
    }
  };

  const handlePersist = () => {
    if (!currentFilename || !socketHandler || !editor) return;

    socketHandler.persistFile(currentFilename);

    persistButtonText = "Persisted";
    this.update();

    setTimeout(() => {
      persistButtonText = "Persist";
      this.update();
    }, PERSIST_BUTTON_RESET_DELAY_MS);
  };

  const handleNewFile = () => {
    if (!newFileInput || !socketHandler) {
      console.error(
        "missing newFileInput or socketHandler, can't create new file"
      );
      return;
    }

    const filename = newFileInput.value.trim();

    if (!filename) {
      return;
    }

    const fullFilename = filename.endsWith(".md") ? filename : `${filename}.md`;
    openFile(fullFilename);
    newFileInput.value = "";
  };

  socketHandler = new SocketHandler({
    onFileListUpdate: handleFileListUpdate,
    onSubdocUpdate: handleSubdocUpdate,
    onAwarenessUpdate: handleAwarenessUpdate,
    onSubdocAwarenessUpdate: handleSubdocAwarenessUpdate,
  });

  socketHandler.setAwarenessState({
    name: user.name,
    color: user.color,
  });

  awarenessStates = socketHandler.getAllAwarenessStates();

  return () => (
    <div className="flex flex-col h-full">
      <div className="border-b border-base-200 px-4 py-3">
        <h1 className="font-bold text-center">marky</h1>
      </div>

      <div className="flex flex-1 overflow-hidden">
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
                    newFileInput = event.currentTarget as HTMLInputElement;
                    on(event.currentTarget, {
                      keydown: (e: KeyboardEvent) => {
                        if (e.key === "Enter") {
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
                    on(event.currentTarget, {
                      click: () => {
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

        <div className="flex-1 flex flex-col">
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
                editorElement = event.currentTarget;
                if (editor) {
                  editor.mount(editorElement);
                } else if (currentFilename && socketHandler) {
                  const subdoc = socketHandler.getSubdoc(currentFilename);
                  if (subdoc) {
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
