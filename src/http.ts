import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Request, Response } from "express";
import type { AccessMode } from "./db.js";
import { closeAll } from "./db.js";
import { createServer } from "./server.js";

export async function startHttpServer(accessMode: AccessMode, host: string, port: number): Promise<void> {
  const app = createMcpExpressApp({ host });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createServer(accessMode);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: String(e) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    app.listen(port, host, (err?: Error) => (err ? reject(err) : resolve()));
  });

  console.error(`postgres-mcp listening on http://${host}:${port}/mcp`);

  process.on("SIGINT", () => void closeAll().then(() => process.exit(0)));
  process.on("SIGTERM", () => void closeAll().then(() => process.exit(0)));
}
