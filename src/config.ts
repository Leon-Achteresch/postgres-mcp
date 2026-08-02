export type DatabaseConfig = { databases: Record<string, string>; defaultDb: string };

function fromEnvPattern(): Record<string, string> {
  const dbs: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^DB_(.+)_URL$/);
    if (match && value) dbs[match[1].toLowerCase()] = value;
  }
  return dbs;
}

function parseDatabasesEnv(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    const dbs: Record<string, string> = {};
    for (const part of raw.split(",")) {
      const sep = part.indexOf("|");
      if (sep === -1) continue;
      const id = part.slice(0, sep).trim();
      const url = part.slice(sep + 1).trim();
      if (id && url) dbs[id] = url;
    }
    if (Object.keys(dbs).length > 0) return dbs;
  }
  return {};
}

export function loadDatabaseConfig(): DatabaseConfig {
  const databases = { ...fromEnvPattern() };
  if (process.env.DATABASES) Object.assign(databases, parseDatabasesEnv(process.env.DATABASES));
  if (process.env.DATABASE_URL) databases.default ??= process.env.DATABASE_URL;
  if (Object.keys(databases).length === 0) {
    databases.default = "postgres://localhost:5432/postgres";
  }
  const defaultDb =
    process.env.DEFAULT_DB && databases[process.env.DEFAULT_DB]
      ? process.env.DEFAULT_DB
      : (databases.default ? "default" : Object.keys(databases)[0]);
  return { databases, defaultDb };
}

export type Transport = "stdio" | "http";

export function parseTransport(): Transport {
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--transport=(.+)$/);
    if (match) return match[1] === "http" ? "http" : "stdio";
  }
  return process.env.TRANSPORT === "http" ? "http" : "stdio";
}

export function parsePort(): number {
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--port=(\d+)$/);
    if (match) return parseInt(match[1], 10);
  }
  return parseInt(process.env.PORT ?? "8000", 10);
}

export function parseHost(): string {
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--host=(.+)$/);
    if (match) return match[1];
  }
  return process.env.BIND_HOST ?? "0.0.0.0";
}
