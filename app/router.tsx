import { createRouter } from "@remix-run/fetch-router";
import { logger } from "@remix-run/fetch-router/logger-middleware";

import { routes } from "../routes.ts";

import * as publicHandlers from "./public.ts";
import { render } from "./utils/render.ts";

let middleware = [];

if (process.env.NODE_ENV === "development") {
  middleware.push(logger());
}

export let router = createRouter({ middleware });

router.get(routes.assets, publicHandlers.assets);

router.map(routes.home, () =>
  render(
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>marky</title>
        <script
          type="module"
          async
          src={routes.assets.href({ path: "entry.js" })}
        />
        <link
          rel="stylesheet"
          href={routes.assets.href({ path: "style.css" })}
        />
      </head>
      <body>
        <div id="root" />
      </body>
    </html>
  )
);
