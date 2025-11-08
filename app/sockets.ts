import { WebSocketServer, WebSocket } from "ws";
import type Stream from "node:stream";
import type http from "node:http";
import * as Y from "yjs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import {
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import { plainTextSchema } from "./frontend/schema.js";

// Helper to convert plain text string to ProseMirror doc
function textToDoc(text: string): ReturnType<typeof plainTextSchema.node> {
  if (!text) {
    return plainTextSchema.node("doc", null, [
      plainTextSchema.node("paragraph"),
    ]);
  }
  const lines = text.split("\n");
  const paragraphs = lines.map((line) => {
    if (line === "") {
      return plainTextSchema.node("paragraph");
    }
    return plainTextSchema.node("paragraph", null, [
      plainTextSchema.text(line),
    ]);
  });
  return plainTextSchema.node("doc", null, paragraphs);
}

// Helper to convert ProseMirror doc to plain text string
function docToText(doc: ReturnType<typeof plainTextSchema.node>): string {
  const paragraphs: string[] = [];
  doc.forEach((node) => {
    if (node.type.name === "paragraph") {
      paragraphs.push(node.textContent);
    }
  });
  return paragraphs.join("\n");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const contentDir = path.join(__dirname, "..", "content");

const rootDoc = new Y.Doc();
const filesMap = rootDoc.getMap("files");
// Track filename -> subdoc mapping separately for easier access
const filenameToSubdoc = new Map<string, Y.Doc>();
// Track filename -> subdoc awareness mapping
const filenameToSubdocAwareness = new Map<string, Awareness>();

interface Client {
  ws: WebSocket;
  id: number;
}

const clients = new Set<Client>();

const messageSync = 0;
const messageAwareness = 1;
const messageFileList = 2;
const messageOpenFile = 3;
const messagePersistFile = 4;
const messageSubdocSync = 5; // Sync message for subdocuments (includes filename)
const messageSubdocAwareness = 6; // Awareness message for subdocuments (includes filename)

const wss = new WebSocketServer({ noServer: true });

let currentClientId = 0;

// Track which files exist on disk
const filesOnDisk = new Set<string>();

// Scan content directory for markdown files
async function scanContentDirectory() {
  try {
    const files = await fs.readdir(contentDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    filesOnDisk.clear();
    for (const file of mdFiles) {
      filesOnDisk.add(file);
      if (!filenameToSubdoc.has(file)) {
        const subdoc = new Y.Doc();
        filesMap.set(file, subdoc);
        filenameToSubdoc.set(file, subdoc);
      }
    }

    // Remove subdocs for files that no longer exist
    const keysToRemove: string[] = [];
    filenameToSubdoc.forEach((_, key) => {
      if (!filesOnDisk.has(key)) {
        keysToRemove.push(key);
      }
    });
    keysToRemove.forEach((key) => {
      const subdoc = filenameToSubdoc.get(key);
      if (subdoc) {
        subdoc.destroy();
        filesMap.delete(key);
        filenameToSubdoc.delete(key);
      }
    });

    return Array.from(filesOnDisk);
  } catch (error) {
    console.error("Error scanning content directory:", error);
    return [];
  }
}

// Load file content from disk into subdocument
async function loadFileContent(filename: string, subdoc: Y.Doc) {
  const filePath = path.join(contentDir, filename);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    // Convert plain text to ProseMirror doc and populate XmlFragment
    const doc = textToDoc(content);
    const xmlFragment = subdoc.getXmlFragment("prosemirror");
    xmlFragment.delete(0, xmlFragment.length);
    prosemirrorToYXmlFragment(doc, xmlFragment);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist - create empty file
      await fs.writeFile(filePath, "", "utf-8");
      filesOnDisk.add(filename);
      // Initialize with empty doc
      const doc = textToDoc("");
      const xmlFragment = subdoc.getXmlFragment("prosemirror");
      xmlFragment.delete(0, xmlFragment.length);
      prosemirrorToYXmlFragment(doc, xmlFragment);
    } else {
      console.error(`Error loading file ${filename}:`, error);
    }
  }
}

// Save subdocument content to disk
async function persistFileContent(filename: string, subdoc: Y.Doc) {
  const filePath = path.join(contentDir, filename);
  try {
    // Read from XmlFragment and convert to plain text
    const xmlFragment = subdoc.getXmlFragment("prosemirror");
    const doc = yXmlFragmentToProseMirrorRootNode(xmlFragment, plainTextSchema);
    const content = docToText(doc);
    await fs.writeFile(filePath, content, "utf-8");
    filesOnDisk.add(filename);
    return true;
  } catch (error) {
    console.error(`Error persisting file ${filename}:`, error);
    return false;
  }
}

// Send file list to a client
function sendFileList(ws: WebSocket) {
  const files = Array.from(filenameToSubdoc.keys());
  console.log(`Sending file list of ${files.length} files`);
  const message = Buffer.concat([
    Buffer.from([messageFileList]),
    Buffer.from(JSON.stringify(files)),
  ]);
  ws.send(message);
}

// Handle subdocs event
rootDoc.on("subdocs", ({ added, removed, loaded }) => {
  loaded.forEach((subdoc) => {
    // Find which file this subdoc belongs to
    filenameToSubdoc.forEach((doc, filename) => {
      if (doc === subdoc) {
        loadFileContent(filename, doc).catch((error) => {
          console.error(`Error loading content for ${filename}:`, error);
        });
      }
    });
  });

  // Broadcast file list updates to all clients
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      sendFileList(client.ws);
    }
  });
});

// Initialize: scan directory and create subdocs
scanContentDirectory().then((files) => {
  console.log(`Found ${files.length} markdown files in content directory`);
});

// Track which subdocuments each client has loaded
const clientSubdocs = new Map<WebSocket, Map<string, Y.Doc>>();

wss.on("connection", (ws: WebSocket) => {
  currentClientId++;

  const clientId = currentClientId;

  const client = { ws, id: clientId };
  clients.add(client);
  clientSubdocs.set(ws, new Map());

  // Send root doc state
  const syncStep1 = Y.encodeStateAsUpdate(rootDoc);
  ws.send(Buffer.concat([Buffer.from([messageSync]), syncStep1]));

  // Send file list
  sendFileList(ws);

  // Handle root doc updates
  const rootDocUpdateHandler = (update: Uint8Array, origin: any) => {
    if (origin !== ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          Buffer.concat([Buffer.from([messageSync]), Buffer.from(update)])
        );
      }
    }
  };

  rootDoc.on("update", rootDocUpdateHandler);

  // Handle subdoc updates
  const subdocUpdateHandlers = new Map<Y.Doc, (update: Uint8Array) => void>();

  ws.on("message", async (message: Buffer) => {
    if (message.length === 0) return;

    const messageType = message[0];
    const content = message.slice(1);

    if (messageType === messageSync) {
      try {
        // Root doc sync
        Y.applyUpdate(rootDoc, content, ws);

        // Broadcast to other clients
        clients.forEach((client) => {
          if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(
              Buffer.concat([Buffer.from([messageSync]), content])
            );
          }
        });
      } catch (error) {
        console.error("Error applying Yjs update:", error);
      }
    } else if (messageType === messageSubdocSync) {
      try {
        // Subdoc sync - format: [filenameLength (1 byte)][filename][update]
        const filenameLength = content[0];
        const filename = content.slice(1, 1 + filenameLength).toString("utf-8");
        const update = content.slice(1 + filenameLength);

        const subdoc = filenameToSubdoc.get(filename);
        if (subdoc) {
          Y.applyUpdate(subdoc, update, ws);

          // Broadcast to other clients that have this subdoc loaded
          clients.forEach((client) => {
            const subs = clientSubdocs.get(client.ws);
            if (
              subs &&
              subs.has(filename) &&
              client.ws !== ws &&
              client.ws.readyState === WebSocket.OPEN
            ) {
              client.ws.send(
                Buffer.concat([
                  Buffer.from([messageSubdocSync]),
                  Buffer.from([filenameLength]),
                  Buffer.from(filename, "utf-8"),
                  Buffer.from(update),
                ])
              );
            }
          });
        }
      } catch (error) {
        console.error("Error applying subdoc update:", error);
      }
    } else if (messageType === messageAwareness) {
      // Root awareness updates are broadcast to all clients
      clients.forEach((client) => {
        if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(
            Buffer.concat([Buffer.from([messageAwareness]), content])
          );
        }
      });
    } else if (messageType === messageSubdocAwareness) {
      try {
        // Format: [filenameLength (1 byte)][filename][awarenessUpdate]
        const filenameLength = content[0];
        const filename = content.slice(1, 1 + filenameLength).toString("utf-8");
        const awarenessUpdate = content.slice(1 + filenameLength);

        // Get or create subdoc awareness
        let subdocAwareness = filenameToSubdocAwareness.get(filename);
        if (!subdocAwareness) {
          const subdoc = filenameToSubdoc.get(filename);
          if (subdoc) {
            subdocAwareness = new Awareness(subdoc);
            filenameToSubdocAwareness.set(filename, subdocAwareness);
          }
        }

        if (subdocAwareness) {
          // Apply the awareness update
          applyAwarenessUpdate(subdocAwareness, awarenessUpdate, ws);

          // Broadcast to other clients viewing this subdoc
          clients.forEach((client) => {
            const clientSubs = clientSubdocs.get(client.ws);
            if (
              client.ws !== ws &&
              clientSubs &&
              clientSubs.has(filename) &&
              client.ws.readyState === WebSocket.OPEN
            ) {
              const filenameBuf = Buffer.from(filename, "utf-8");
              client.ws.send(
                Buffer.concat([
                  Buffer.from([messageSubdocAwareness]),
                  Buffer.from([filenameBuf.length]),
                  filenameBuf,
                  Buffer.from(awarenessUpdate),
                ])
              );
            }
          });
        }
      } catch (error) {
        console.error("Error handling subdoc awareness:", error);
      }
    } else if (messageType === messageOpenFile) {
      try {
        const filename = content.toString("utf-8");

        // Get or create subdocument
        let subdoc = filenameToSubdoc.get(filename);
        if (!subdoc) {
          subdoc = new Y.Doc();
          filesMap.set(filename, subdoc);
          filenameToSubdoc.set(filename, subdoc);
        }

        // Create subdoc awareness if it doesn't exist
        if (!filenameToSubdocAwareness.has(filename)) {
          const subdocAwareness = new Awareness(subdoc);
          filenameToSubdocAwareness.set(filename, subdocAwareness);
        }

        // Track that this client has this subdoc
        const clientSubs = clientSubdocs.get(ws);
        if (clientSubs) {
          clientSubs.set(filename, subdoc);
        }

        // Load file content from disk BEFORE loading the subdoc
        // This ensures content is available when subdoc is synced
        await loadFileContent(filename, subdoc);

        // Load the subdoc (triggers subdocs event)
        subdoc.load();

        // Broadcast updated file list to all clients (in case this is a new file)
        clients.forEach((client) => {
          if (client.ws.readyState === WebSocket.OPEN) {
            sendFileList(client.ws);
          }
        });

        // Send subdoc state to client with filename
        const subdocUpdate = Y.encodeStateAsUpdate(subdoc);
        const filenameBuf = Buffer.from(filename, "utf-8");
        ws.send(
          Buffer.concat([
            Buffer.from([messageSubdocSync]),
            Buffer.from([filenameBuf.length]),
            filenameBuf,
            Buffer.from(subdocUpdate),
          ])
        );

        // Send subdoc awareness state to client
        const subdocAwareness = filenameToSubdocAwareness.get(filename);
        if (subdocAwareness) {
          const awarenessUpdate = encodeAwarenessUpdate(subdocAwareness, [
            ...subdocAwareness.getStates().keys(),
          ]);
          if (awarenessUpdate.length > 0) {
            ws.send(
              Buffer.concat([
                Buffer.from([messageSubdocAwareness]),
                Buffer.from([filenameBuf.length]),
                filenameBuf,
                Buffer.from(awarenessUpdate),
              ])
            );
          }
        }

        // Set up update handler for this subdoc if not already set
        // This handles updates from server-side changes (like loading from disk)
        if (!subdocUpdateHandlers.has(subdoc)) {
          const handler = (update: Uint8Array) => {
            const filenameBuf = Buffer.from(filename, "utf-8");
            clients.forEach((c) => {
              const subs = clientSubdocs.get(c.ws);
              if (
                subs &&
                subs.has(filename) &&
                c.ws.readyState === WebSocket.OPEN
              ) {
                c.ws.send(
                  Buffer.concat([
                    Buffer.from([messageSubdocSync]),
                    Buffer.from([filenameBuf.length]),
                    filenameBuf,
                    Buffer.from(update),
                  ])
                );
              }
            });
          };
          subdoc.on("update", handler);
          subdocUpdateHandlers.set(subdoc, handler);
        }
      } catch (error) {
        console.error("Error opening file:", error);
      }
    } else if (messageType === messagePersistFile) {
      try {
        const filename = content.toString("utf-8");
        const subdoc = filenameToSubdoc.get(filename);

        if (subdoc) {
          const success = await persistFileContent(filename, subdoc);
          if (success) {
            // Rescan directory to update file list
            await scanContentDirectory();
          }
        } else {
          console.error(`Cannot persist file ${filename}: subdoc not found`);
        }
      } catch (error) {
        console.error("Error persisting file:", error);
      }
    }
  });

  ws.on("close", () => {
    clients.forEach((c) => {
      if (c.ws === ws) {
        clients.delete(c);
      }
    });
    clientSubdocs.delete(ws);
    rootDoc.off("update", rootDocUpdateHandler);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", { clientId, error });
    clients.forEach((c) => {
      if (c.ws === ws) {
        clients.delete(c);
      }
    });
    clientSubdocs.delete(ws);
    rootDoc.off("update", rootDocUpdateHandler);
  });
});

export const handleUpgrade = (
  request: http.IncomingMessage,
  socket: Stream.Duplex,
  head: Buffer
) => {
  wss.handleUpgrade(request, socket, head, (socket) => {
    wss.emit("connection", socket, request);
  });
};
