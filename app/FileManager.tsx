"use client";

import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useEffectEvent,
} from "react";
import { YDocProvider } from "@y-sweet/react";
import { createYjsProvider } from "@y-sweet/client";
import * as Y from "yjs";
import { CodeEditor, CodeEditorRef } from "./CodeEditor";
import { listFiles, readFile, saveFile, createFile } from "./actions";
import { slugify } from "@/lib/utils";
import { useLocalPresence } from "./usePresence";
import { PresenceManager } from "./PresenceManager";

function useGlobalUsersPerFile(globalAwareness: any, files: string[]) {
  const [usersByFile, setUsersByFile] = useState<
    Map<string, Array<{ name: string; color: string; clientId: number }>>
  >(new Map());

  useEffect(() => {
    if (!globalAwareness) return;

    const updateUsers = () => {
      const newUsersByFile = new Map<
        string,
        Array<{ name: string; color: string; clientId: number }>
      >();

      files.forEach((file) => {
        newUsersByFile.set(file, []);
      });

      globalAwareness.getStates().forEach((state: any, clientId: number) => {
        const user = state.user;
        if (user && user.currentFile) {
          const existing = newUsersByFile.get(user.currentFile) || [];
          existing.push({
            name: user.name || "Anonymous",
            color: user.color || "#aaa",
            clientId,
          });
          newUsersByFile.set(user.currentFile, existing);
        }
      });

      setUsersByFile(newUsersByFile);
    };

    updateUsers();

    const handleChange = () => {
      updateUsers();
    };

    globalAwareness.on("update", handleChange);

    return () => {
      globalAwareness.off("update", handleChange);
    };
  }, [globalAwareness, files]);

  return usersByFile;
}

export function FileManager() {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [showPresenceEditor, setShowPresenceEditor] = useState(false);
  const [editingName, setEditingName] = useState("");
  const [editingColor, setEditingColor] = useState("#000000");
  const editorRef = useRef<CodeEditorRef>(null);
  const { presence, updatePresence } = useLocalPresence();
  const globalProviderRef = useRef<ReturnType<typeof createYjsProvider> | null>(
    null
  );
  const globalDocRef = useRef<Y.Doc | null>(null);
  const globalAwarenessRef = useRef<any>(null);
  const [globalAwareness, setGlobalAwareness] = useState<any>(null);
  const usersByFile = useGlobalUsersPerFile(globalAwareness, files);

  const updateFiles = useEffectEvent(async () => {
    try {
      const fileList = await listFiles();
      setFiles(fileList);
      if (fileList.length > 0 && !selectedFile) {
        setSelectedFile(fileList[0]);
      }
    } catch (error) {
      console.error("Error listing files:", error);
    } finally {
      setIsLoading(false);
    }
  });

  useEffect(() => {
    updateFiles();

    const interval = setInterval(() => {
      updateFiles();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const globalDoc = new Y.Doc();
    const globalProvider = createYjsProvider(globalDoc, "global", "/api/auth");
    globalProviderRef.current = globalProvider;
    globalDocRef.current = globalDoc;

    const awareness = globalProvider.awareness;
    globalAwarenessRef.current = awareness;
    setGlobalAwareness(awareness);

    return () => {
      globalProvider.destroy();
      setGlobalAwareness(null);
    };
  }, []);

  useEffect(() => {
    if (globalAwareness && selectedFile) {
      globalAwareness.setLocalStateField("user", {
        name: presence.name,
        color: presence.color,
        currentFile: selectedFile,
      });
    }
  }, [presence, selectedFile, globalAwareness]);

  const handleEditorReady = useCallback(() => {
    if (selectedFile) {
      loadFileContent(selectedFile);
    }
  }, [selectedFile]);

  async function loadFileContent(filename: string) {
    try {
      if (editorRef.current && !editorRef.current.hasExistingContent()) {
        const content = await readFile(filename);
        editorRef.current.setContent(content);
      }
    } catch (error) {
      console.error("Error loading file content:", error);
      alert(`Failed to load file: ${filename}`);
    }
  }

  async function handleSave() {
    if (!selectedFile || !editorRef.current) return;

    setIsSaving(true);
    try {
      const content = editorRef.current.getContent();
      await saveFile(selectedFile, content);
      alert("File saved successfully!");
    } catch (error) {
      console.error("Error saving file:", error);
      alert(
        `Failed to save file: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCreateFile() {
    if (!newFileName.trim()) {
      alert("Please enter a filename");
      return;
    }

    const filename = newFileName.trim().endsWith(".md")
      ? newFileName.trim()
      : `${newFileName.trim()}.md`;

    try {
      await createFile(filename);
      await updateFiles();
      setSelectedFile(filename);
      setNewFileName("");
      setShowNewFileInput(false);
      if (editorRef.current) {
        editorRef.current.setContent("");
      }
    } catch (error) {
      console.error("Error creating file:", error);
      alert(
        `Failed to create file: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  const docId = selectedFile
    ? slugify(selectedFile.replace(/\.md$/, ""))
    : undefined;

  if (!docId) {
    return <div>Loading...</div>;
  }

  return (
    <YDocProvider
      key={docId}
      docId={docId}
      authEndpoint="/api/auth"
      offlineSupport={true}
    >
      <div className="flex flex-col h-screen">
        <div className="flex items-center gap-4 p-4 border-b">
          <h1 className="text-2xl font-bold">marky</h1>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded cursor-pointer hover:bg-gray-100"
              onClick={() => {
                setShowPresenceEditor(!showPresenceEditor);
                setEditingName(presence.name);
              }}
            >
              <div
                className="w-4 h-4 rounded-full"
                style={{ backgroundColor: presence.color }}
              />
              <span className="text-sm font-medium">{presence.name}</span>
            </div>
          </div>
          <button
            onClick={() => setShowNewFileInput(!showNewFileInput)}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            New File
          </button>
          <button
            onClick={handleSave}
            disabled={!selectedFile || isSaving}
            className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? "Saving..." : "Persist"}
          </button>
        </div>

        {showPresenceEditor && (
          <div className="p-4 border-b bg-gray-50">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium w-20">Name:</label>
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  placeholder="Enter your name"
                  className="flex-1 px-3 py-2 border rounded"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      updatePresence({ name: editingName });
                      setShowPresenceEditor(false);
                    } else if (e.key === "Escape") {
                      setShowPresenceEditor(false);
                    }
                  }}
                  autoFocus
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium w-20">Color:</label>
                <input
                  type="color"
                  value={editingColor}
                  onChange={(e) => setEditingColor(e.target.value)}
                  className="w-8 h-8 rounded"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => {
                    updatePresence({ name: editingName, color: editingColor });
                    setShowPresenceEditor(false);
                  }}
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setShowPresenceEditor(false);
                    setEditingName(presence.name);
                  }}
                  className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {showNewFileInput && (
          <div className="p-4 border-b bg-gray-50">
            <div className="flex gap-2">
              <input
                type="text"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder="Enter filename (e.g., my-file)"
                className="flex-1 px-3 py-2 border rounded"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleCreateFile();
                  } else if (e.key === "Escape") {
                    setShowNewFileInput(false);
                    setNewFileName("");
                  }
                }}
                autoFocus
              />
              <button
                onClick={handleCreateFile}
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setShowNewFileInput(false);
                  setNewFileName("");
                }}
                className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          <div className="w-64 border-r overflow-y-auto bg-gray-50">
            <div className="p-2 font-semibold text-sm text-gray-700">Files</div>
            {isLoading ? (
              <div className="p-4 text-gray-500">Loading files...</div>
            ) : files.length === 0 ? (
              <div className="p-4 text-gray-500">No files found</div>
            ) : (
              <div className="flex flex-col">
                {files.map((file) => {
                  const users = usersByFile.get(file) || [];
                  return (
                    <button
                      key={file}
                      onClick={() => setSelectedFile(file)}
                      className={`px-4 py-2 text-left hover:bg-gray-200 flex items-center justify-between ${
                        selectedFile === file ? "bg-blue-100 font-semibold" : ""
                      }`}
                    >
                      <span>{file.replace(/\.md$/, "")}</span>
                      {users.length > 0 && (
                        <div className="flex items-center gap-1 ml-2">
                          {users.map((user) => (
                            <div key={user.clientId} className="relative group">
                              <span
                                className="inline-block w-3 h-3 rounded-full border border-gray-300 cursor-pointer"
                                style={{ backgroundColor: user.color }}
                              />
                              <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                                {user.name}
                                <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                                  <div className="border-4 border-transparent border-t-gray-900"></div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-hidden">
            {selectedFile ? (
              <div className="h-full">
                <div className="p-2 border-b bg-gray-50 text-sm text-gray-600 flex items-center justify-between">
                  Editing: {selectedFile.replace(/\.md$/, "")}
                  <PresenceManager presence={presence} />
                </div>
                <CodeEditor ref={editorRef} onReady={handleEditorReady} />
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                Select a file to edit
              </div>
            )}
          </div>
        </div>
      </div>
    </YDocProvider>
  );
}
