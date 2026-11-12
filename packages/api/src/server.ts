import "dotenv/config";

import { listenHost, loadConfig } from "./config.js";
import { createLifecycle } from "./lifecycle.js";
import { createPortfolioRuntime } from "./runtime.js";

const config = loadConfig(process.env);
const runtime = createPortfolioRuntime(config);
const port = Number(process.env.PORT ?? 3004);
// Loopback unless told otherwise: running the API directly never exposes the plain-http login on the LAN. The container
// sets HOST=0.0.0.0 (docker-compose.yml) and Compose still publishes the port on 127.0.0.1 only.
const host = listenHost(process.env);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Invalid server configuration: PORT");
}

await runtime.ready;

const lifecycle = createLifecycle({
  startScheduler: () => runtime.startScheduler(),
  closeServer: (done) => { server.close(done); },
  closeAllConnections: () => { server.closeAllConnections(); },
  drainBackground: () => runtime.drainBackground(),
  closeRuntime: () => runtime.close(),
  onCloseError: () => {
    console.error("Portfolio server shutdown failed");
    process.exitCode = 1;
  },
});
const server = runtime.app.listen(port, host, () => {
  console.log(`Portfolio API listening on ${host}:${port}`);
  // Jobs are armed only once the server accepts connections (and never after shutdown began); nothing runs at startup.
  lifecycle.onListening();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => lifecycle.shutdown());
}
