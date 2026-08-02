#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadDatabaseConfig,
  parseHost,
  parsePort,
  parseTransport,
} from "./config.js";
import { closeAll, initDb, type AccessMode } from "./db.js";
import { startHttpServer } from "./http.js";
import { createServer } from "./server.js";

function parseAccessMode(): AccessMode {
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--access-mode=(.+)$/);
    if (match) return match[1] === "restricted" ? "restricted" : "unrestricted";
  }
  return process.env.ACCESS_MODE === "restricted" ? "restricted" : "unrestricted";
}

const accessMode = parseAccessMode();
const dbConfig = loadDatabaseConfig();
initDb(accessMode, dbConfig);

const transport = parseTransport();

if (transport === "http") {
  const host = parseHost();
  const port = parsePort();
  await startHttpServer(accessMode, host, port);
} else {
  const server = createServer(accessMode);
  await server.connect(new StdioServerTransport());
  process.on("SIGINT", () => void closeAll().then(() => process.exit(0)));
}
