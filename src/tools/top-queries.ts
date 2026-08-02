import { checkExtension, getPostgresVersion, pgStatColumns, PG_STAT_MSG } from "../extensions.js";
import { query } from "../db.js";
import { error, text } from "../response.js";

export async function getTopQueries(
  sortBy: "mean_time" | "total_time",
  limit: number,
  db?: string
) {
  try {
    const ext = await checkExtension("pg_stat_statements", db);
    if (!ext.installed) return text(PG_STAT_MSG);
    const version = await getPostgresVersion(db);
    const cols = pgStatColumns(version);
    const orderCol = sortBy === "total_time" ? cols.total : cols.mean;
    const result = await query(
      db,
      `SELECT left(query, 200) AS query, calls, round(${cols.mean}::numeric, 2) AS mean_ms,
              round(${cols.total}::numeric, 2) AS total_ms, rows
       FROM pg_stat_statements ORDER BY ${orderCol} DESC LIMIT ${limit}`
    );
    return text(result);
  } catch (e) {
    return error(String(e));
  }
}

export async function getTopResourceQueries(fracThreshold = 0.05, db?: string) {
  try {
    const ext = await checkExtension("pg_stat_statements", db);
    if (!ext.installed) return text(PG_STAT_MSG);
    const version = await getPostgresVersion(db);
    const cols = pgStatColumns(version);
    const walSelect = version >= 13 ? "wal_bytes" : "0 AS wal_bytes";
    const walFrac =
      version >= 13
        ? "wal_bytes / NULLIF(SUM(wal_bytes) OVER (), 0)"
        : "0";
    const result = await query(
      db,
      `WITH rf AS (
        SELECT left(query, 200) AS query, calls,
          round(${cols.total}::numeric, 2) AS total_ms,
          round((${cols.total} / NULLIF(SUM(${cols.total}) OVER (), 0))::numeric, 4) AS time_frac,
          round(((${walFrac}))::numeric, 4) AS wal_frac
        FROM pg_stat_statements
      )
      SELECT query, calls, total_ms, time_frac, wal_frac FROM rf
      WHERE time_frac > ${fracThreshold} OR wal_frac > ${fracThreshold}
      ORDER BY total_ms DESC LIMIT 20`
    );
    return text(result);
  } catch (e) {
    return error(String(e));
  }
}
