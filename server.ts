import * as http from "node:http";
import { createRequestListener } from "@remix-run/node-fetch-server";

import { router } from "./app/router.tsx";
import { handleUpgrade } from "./app/sockets.ts";

let server = http.createServer(
  createRequestListener(async (request) => {
    try {
      return await router.fetch(request);
    } catch (error) {
      console.error(error);
      return new Response("Internal Server Error", { status: 500 });
    }
  })
);

server.on("upgrade", (request, socket, head) => {
  if (
    !["/ws", "/ws/"].includes(request.url ?? "") ||
    request.method !== "GET"
  ) {
    socket.destroy();
    return;
  }

  handleUpgrade(request, socket, head);
});

let port = process.env.PORT ? parseInt(process.env.PORT, 10) : 44100;

server.listen(port, () => {
  console.log(`marky is running on http://localhost:${port}`);
});
