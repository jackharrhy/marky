import { WebSocketServer, WebSocket } from "ws";
import type Stream from "node:stream";
import type http from "node:http";
import * as Y from "yjs";

const ydoc = new Y.Doc();

interface Client {
  ws: WebSocket;
  id: number;
}

const clients = new Set<Client>();

const messageSync = 0;
const messageAwareness = 1;

const wss = new WebSocketServer({ noServer: true });

let currentClientId = 0;

wss.on("connection", (ws: WebSocket) => {
  currentClientId++;

  const clientId = currentClientId;

  console.log("new client connected", { clientId });
  const client = { ws, id: clientId };
  clients.add(client);

  const syncStep1 = Y.encodeStateAsUpdate(ydoc);
  ws.send(Buffer.concat([Buffer.from([messageSync]), syncStep1]));

  ws.on("message", (message: Buffer) => {
    if (message.length === 0) return;

    const messageType = message[0];
    const content = message.slice(1);

    if (messageType === messageSync) {
      try {
        Y.applyUpdate(ydoc, content);
        console.log("applied update", { clientId });

        clients.forEach((client) => {
          if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
            console.log("sending update to client", {
              fromClientId: clientId,
              toClientId: client.id,
            });
            client.ws.send(
              Buffer.concat([Buffer.from([messageSync]), content])
            );
          }
        });
      } catch (error) {
        console.error("Error applying Yjs update:", error);
      }
    } else if (messageType === messageAwareness) {
      clients.forEach((client) => {
        if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(
            Buffer.concat([Buffer.from([messageAwareness]), content])
          );
        }
      });
    }
  });

  ws.on("close", () => {
    console.log("client disconnected", { clientId });
    clients.forEach((c) => {
      if (c.ws === ws) {
        clients.delete(c);
      }
    });
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", { clientId, error });
    clients.forEach((c) => {
      if (c.ws === ws) {
        clients.delete(c);
      }
    });
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
