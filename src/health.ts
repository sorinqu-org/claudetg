import { createServer, type Server } from "node:http";
import type { Logger } from "./logger.js";

export function startHealthServer(port: number, logger: Logger): Server {
  const startedAt = Date.now();
  const server = createServer((request, response) => {
    if (request.url === "/healthz" || request.url === "/readyz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok", uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(port, "0.0.0.0", () => logger.info("Health server listening", { port }));
  return server;
}
