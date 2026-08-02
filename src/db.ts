import postgres from "postgres";
import type { DatabaseConfig } from "./config.js";

export type AccessMode = "unrestricted" | "restricted";

const RESTRICTED_TIMEOUT_MS = 30_000;
const TX_CONTROL = /\b(commit|rollback|savepoint|release\s+savepoint)\b/i;
const SET_TX = /\bset\s+(local\s+)?transaction\b/i;

const pools = new Map<string, postgres.Sql>();
let accessMode: AccessMode = "unrestricted";
let defaultDb = "default";

export function initDb(mode: AccessMode, config: DatabaseConfig): void {
  accessMode = mode;
  defaultDb = config.defaultDb;
  for (const pool of pools.values()) void pool.end({ timeout: 0 });
  pools.clear();
  for (const [id, url] of Object.entries(config.databases)) {
    pools.set(id, postgres(url));
  }
}

export function getAccessMode(): AccessMode {
  return accessMode;
}

export function resolveDb(db?: string): string {
  const id = db ?? defaultDb;
  if (!pools.has(id)) {
    throw new Error(`Unknown database '${id}'. Available: ${[...pools.keys()].join(", ")}`);
  }
  return id;
}

export function listDatabaseIds(): { id: string; default: boolean }[] {
  return [...pools.keys()].map((id) => ({ id, default: id === defaultDb }));
}

export function assertNoTransactionControl(statement: string): void {
  if (TX_CONTROL.test(statement) || SET_TX.test(statement)) {
    throw new Error("Transaction control statements are not allowed in restricted mode");
  }
}

export async function query(db: string | undefined, statement: string): Promise<postgres.Row[]> {
  const sql = pools.get(resolveDb(db))!;
  if (accessMode === "restricted") {
    assertNoTransactionControl(statement);
    return sql.begin("read only", async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${RESTRICTED_TIMEOUT_MS}`);
      return tx.unsafe(statement);
    }) as Promise<postgres.Row[]>;
  }
  return sql.unsafe(statement);
}

export async function closeAll(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end({ timeout: 5 })));
}
