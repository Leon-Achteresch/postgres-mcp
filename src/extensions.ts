import { query } from "./db.js";

type ExtensionStatus = { installed: boolean; available: boolean; version?: string };

const versionCache = new Map<string, number>();

export async function checkExtension(name: string, db?: string): Promise<ExtensionStatus> {
  const installed = await query(db, `SELECT extversion FROM pg_extension WHERE extname = '${name}'`);
  if (installed.length > 0) {
    return { installed: true, available: true, version: String(installed[0].extversion) };
  }
  const available = await query(db, `SELECT default_version FROM pg_available_extensions WHERE name = '${name}'`);
  return {
    installed: false,
    available: available.length > 0,
    version: String(available[0]?.default_version ?? ""),
  };
}

export async function getPostgresVersion(db?: string): Promise<number> {
  const key = db ?? "_default";
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached;
  const rows = await query(db, "SHOW server_version");
  const version = parseInt(String(rows[0]?.server_version ?? "0").split(".")[0], 10);
  versionCache.set(key, version);
  return version;
}

export function pgStatColumns(version: number) {
  if (version >= 13) {
    return { total: "total_exec_time", mean: "mean_exec_time", stddev: "stddev_exec_time", wal: "wal_bytes" };
  }
  return { total: "total_time", mean: "mean_time", stddev: "stddev_time", wal: "0 AS wal_bytes" };
}

export async function hypopgStatus(db?: string): Promise<{ ok: boolean; message: string }> {
  const status = await checkExtension("hypopg", db);
  if (status.installed) return { ok: true, message: "hypopg installed" };
  if (status.available) {
    return { ok: false, message: "hypopg required. Run: CREATE EXTENSION hypopg;" };
  }
  const version = await getPostgresVersion(db);
  return {
    ok: false,
    message: `hypopg not available. Install postgresql-${version || "XX"}-hypopg, then CREATE EXTENSION hypopg;`,
  };
}

export const PG_STAT_MSG = "pg_stat_statements required. Run: CREATE EXTENSION pg_stat_statements;";
