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
import { textToDoc, docToText, plainTextSchema } from "./shared/doc-utils.js";
import {
  MESSAGE_TYPE_SYNC,
  MESSAGE_TYPE_AWARENESS,
  MESSAGE_TYPE_FILE_LIST,
  MESSAGE_TYPE_OPEN_FILE,
  MESSAGE_TYPE_PERSIST_FILE,
  MESSAGE_TYPE_SUBDOC_SYNC,
  MESSAGE_TYPE_SUBDOC_AWARENESS,
} from "./shared/message-types.js";
import {
  PROSEMIRROR_FRAGMENT_NAME,
  MARKDOWN_EXTENSION,
} from "./shared/constants.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const contentDir = path.join(__dirname, "..", "content");

const rootDoc = new Y.Doc();
const filesMap = rootDoc.getMap("files");
const filenameToSubdoc = new Map<string, Y.Doc>();
const filenameToSubdocAwareness = new Map<string, Awareness>();

interface Client {
  ws: WebSocket;
  id: number;
}

const clients = new Set<Client>();

const wss = new WebSocketServer({ noServer: true });

let currentClientId = 0;

const filesOnDisk = new Set<string>();

async function scanContentDirectory() {
  try {
    const files = await fs.readdir(contentDir);
    const mdFiles = files.filter((f) => f.endsWith(MARKDOWN_EXTENSION));

    filesOnDisk.clear();
    for (const file of mdFiles) {
      filesOnDisk.add(file);
      if (!filenameToSubdoc.has(file)) {
        const subdoc = new Y.Doc();
        filesMap.set(file, subdoc);
        filenameToSubdoc.set(file, subdoc);
      }
    }

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

async function loadFileContent(filename: string, subdoc: Y.Doc) {
  const filePath = path.join(contentDir, filename);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const doc = textToDoc(content);
    const xmlFragment = subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    xmlFragment.delete(0, xmlFragment.length);
    prosemirrorToYXmlFragment(doc, xmlFragment);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.writeFile(filePath, "", "utf-8");
      filesOnDisk.add(filename);
      const doc = textToDoc("");
      const xmlFragment = subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
      xmlFragment.delete(0, xmlFragment.length);
      prosemirrorToYXmlFragment(doc, xmlFragment);
    } else {
      console.error(`Error loading file ${filename}:`, error);
    }
  }
}

async function persistFileContent(filename: string, subdoc: Y.Doc) {
  const filePath = path.join(contentDir, filename);
  try {
    const xmlFragment = subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
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

function sendFileList(ws: WebSocket) {
  const files = Array.from(filenameToSubdoc.keys());
  const message = Buffer.concat([
    Buffer.from([MESSAGE_TYPE_FILE_LIST]),
    Buffer.from(JSON.stringify(files)),
  ]);
  ws.send(message);
}

rootDoc.on("subdocs", ({ added, removed, loaded }) => {
  loaded.forEach((subdoc) => {
    filenameToSubdoc.forEach((doc, filename) => {
      if (doc === subdoc) {
        loadFileContent(filename, doc).catch((error) => {
          console.error(`Error loading content for ${filename}:`, error);
        });
      }
    });
  });

  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      sendFileList(client.ws);
    }
  });
});

scanContentDirectory().then((files) => {
  console.info(`Found ${files.length} markdown files in content directory`);
});

const clientSubdocs = new Map<WebSocket, Map<string, Y.Doc>>();

wss.on("connection", (ws: WebSocket) => {
  currentClientId++;

  const clientId = currentClientId;

  const client = { ws, id: clientId };
  clients.add(client);
  clientSubdocs.set(ws, new Map());

  const syncStep = Y.encodeStateAsUpdate(rootDoc);
  ws.send(Buffer.concat([Buffer.from([MESSAGE_TYPE_SYNC]), syncStep]));

  sendFileList(ws);

  const rootDocUpdateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin !== ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          Buffer.concat([Buffer.from([MESSAGE_TYPE_SYNC]), Buffer.from(update)])
        );
      }
    }
  };

  rootDoc.on("update", rootDocUpdateHandler);

  const subdocUpdateHandlers = new Map<Y.Doc, (update: Uint8Array) => void>();

  ws.on("message", async (message: Buffer) => {
    if (message.length === 0) return;

    const messageType = message[0];
    const content = message.slice(1);

    if (messageType === MESSAGE_TYPE_SYNC) {
      try {
        Y.applyUpdate(rootDoc, content, ws);

        clients.forEach((client) => {
          if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(
              Buffer.concat([Buffer.from([MESSAGE_TYPE_SYNC]), content])
            );
          }
        });
      } catch (error) {
        console.error("Error applying Yjs update:", error);
      }
    } else if (messageType === MESSAGE_TYPE_SUBDOC_SYNC) {
      try {
        const filenameLength = content[0];
        const filename = content.slice(1, 1 + filenameLength).toString("utf-8");
        const update = content.slice(1 + filenameLength);

        const subdoc = filenameToSubdoc.get(filename);
        if (subdoc) {
          Y.applyUpdate(subdoc, update, ws);

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
                  Buffer.from([MESSAGE_TYPE_SUBDOC_SYNC]),
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
    } else if (messageType === MESSAGE_TYPE_AWARENESS) {
      clients.forEach((client) => {
        if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(
            Buffer.concat([Buffer.from([MESSAGE_TYPE_AWARENESS]), content])
          );
        }
      });
    } else if (messageType === MESSAGE_TYPE_SUBDOC_AWARENESS) {
      try {
        const filenameLength = content[0];
        const filename = content.slice(1, 1 + filenameLength).toString("utf-8");
        const awarenessUpdate = content.slice(1 + filenameLength);

        let subdocAwareness = filenameToSubdocAwareness.get(filename);
        if (!subdocAwareness) {
          const subdoc = filenameToSubdoc.get(filename);
          if (subdoc) {
            subdocAwareness = new Awareness(subdoc);
            filenameToSubdocAwareness.set(filename, subdocAwareness);
          }
        }

        if (subdocAwareness) {
          applyAwarenessUpdate(subdocAwareness, awarenessUpdate, ws);

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
                  Buffer.from([MESSAGE_TYPE_SUBDOC_AWARENESS]),
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
    } else if (messageType === MESSAGE_TYPE_OPEN_FILE) {
      try {
        const filename = content.toString("utf-8");

        let subdoc = filenameToSubdoc.get(filename);
        if (!subdoc) {
          subdoc = new Y.Doc();
          filesMap.set(filename, subdoc);
          filenameToSubdoc.set(filename, subdoc);
        }

        if (!filenameToSubdocAwareness.has(filename)) {
          const subdocAwareness = new Awareness(subdoc);
          filenameToSubdocAwareness.set(filename, subdocAwareness);
        }

        const clientSubs = clientSubdocs.get(ws);
        if (clientSubs) {
          clientSubs.set(filename, subdoc);
        }

        await loadFileContent(filename, subdoc);

        subdoc.load();

        clients.forEach((client) => {
          if (client.ws.readyState === WebSocket.OPEN) {
            sendFileList(client.ws);
          }
        });

        const subdocUpdate = Y.encodeStateAsUpdate(subdoc);
        const filenameBuf = Buffer.from(filename, "utf-8");
        ws.send(
          Buffer.concat([
            Buffer.from([MESSAGE_TYPE_SUBDOC_SYNC]),
            Buffer.from([filenameBuf.length]),
            filenameBuf,
            Buffer.from(subdocUpdate),
          ])
        );

        const subdocAwareness = filenameToSubdocAwareness.get(filename);
        if (subdocAwareness) {
          const awarenessUpdate = encodeAwarenessUpdate(subdocAwareness, [
            ...subdocAwareness.getStates().keys(),
          ]);
          if (awarenessUpdate.length > 0) {
            ws.send(
              Buffer.concat([
                Buffer.from([MESSAGE_TYPE_SUBDOC_AWARENESS]),
                Buffer.from([filenameBuf.length]),
                filenameBuf,
                Buffer.from(awarenessUpdate),
              ])
            );
          }
        }

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
                    Buffer.from([MESSAGE_TYPE_SUBDOC_SYNC]),
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
    } else if (messageType === MESSAGE_TYPE_PERSIST_FILE) {
      try {
        const filename = content.toString("utf-8");
        const subdoc = filenameToSubdoc.get(filename);

        if (subdoc) {
          const success = await persistFileContent(filename, subdoc);
          if (success) {
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
