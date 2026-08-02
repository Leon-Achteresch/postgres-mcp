import { query } from "../db.js";
import { error, text } from "../response.js";

const HEALTH_TYPES = ["index", "connection", "vacuum", "sequence", "replication", "buffer", "constraint", "all"] as const;
type HealthType = (typeof HEALTH_TYPES)[number];

async function invalidIndexes(db?: string): Promise<string> {
  const rows = await query(db, `
    SELECT ix.relname AS name, t.relname AS table
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_class ix ON ix.oid = i.indexrelid
    WHERE NOT i.indisvalid
  `);
  if (rows.length === 0) return "No invalid indexes found.";
  return "Invalid indexes found:\n" + rows.map((r) => `${r.name} on ${r.table} is invalid.`).join("\n");
}

async function duplicateIndexes(db?: string): Promise<string> {
  const rows = await query(db, `
    SELECT schemaname AS schema, t.relname AS table, ix.relname AS name,
      regexp_replace(pg_get_indexdef(i.indexrelid), '^[^\\(]*\\((.*)\\)$', '\\1') AS columns,
      regexp_replace(pg_get_indexdef(i.indexrelid), '.* USING ([^ ]*) \\(.*', '\\1') AS using,
      indisunique AS unique, indisprimary AS primary, indisvalid AS valid,
      indexprs::text, indpred::text
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_class ix ON ix.oid = i.indexrelid
    LEFT JOIN pg_stat_user_indexes ui ON ui.indexrelid = i.indexrelid
    WHERE schemaname IS NOT NULL
  `);
  type Idx = {
    schema: string;
    table: string;
    name: string;
    columns: string[];
    using: string;
    unique: boolean;
    primary: boolean;
    valid: boolean;
    indexprs: string;
    indpred: string;
  };
  const indexes: Idx[] = rows.map((r) => ({
    schema: String(r.schema),
    table: String(r.table),
    name: String(r.name),
    using: String(r.using),
    unique: Boolean(r.unique),
    primary: Boolean(r.primary),
    valid: Boolean(r.valid),
    indexprs: String(r.indexprs),
    indpred: String(r.indpred),
    columns: String(r.columns).replace(") WHERE (", " WHERE ").split(", ").map((c) => c.replace(/"/g, "")),
  }));
  const dups: string[] = [];
  for (const idx of indexes.filter((i) => i.valid && !i.primary && !i.unique)) {
    for (const cover of indexes) {
      if (
        cover.valid &&
        cover.name !== idx.name &&
        cover.table === idx.table &&
        cover.schema === idx.schema &&
        cover.using === idx.using &&
        cover.indexprs === idx.indexprs &&
        cover.indpred === idx.indpred &&
        cover.columns.slice(0, idx.columns.length).join() === idx.columns.join()
      ) {
        dups.push(`Index '${idx.name}' on '${idx.table}' is covered by '${cover.name}'`);
        break;
      }
    }
  }
  return dups.length === 0 ? "No duplicate indexes found." : "Duplicate indexes found:\n" + dups.join("\n");
}

async function unusedIndexes(db?: string): Promise<string> {
  const rows = await query(db,`
    SELECT relname AS table, indexrelname AS index, idx_scan, pg_relation_size(i.indexrelid) AS size_bytes, indisprimary AS primary
    FROM pg_stat_user_indexes ui
    JOIN pg_index i ON ui.indexrelid = i.indexrelid
    WHERE NOT indisunique AND idx_scan <= 50
    ORDER BY pg_relation_size(i.indexrelid) DESC
  `);
  const unused = rows.filter((r) => !r.primary);
  if (unused.length === 0) return "No unused indexes found.";
  return (
    "Rarely used indexes found:\n" +
    unused
      .map((r) => {
        const mb = Number(r.size_bytes) / (1024 * 1024);
        return `Index '${r.index}' on '${r.table}' scanned ${r.idx_scan} times, ${mb.toFixed(1)}MB`;
      })
      .join("\n")
  );
}

async function indexBloat(db?: string): Promise<string> {
  const rows = await query(db,`
    SELECT schemaname AS schema, relname AS table, indexrelname AS index,
      pg_relation_size(indexrelid) AS index_bytes
    FROM pg_stat_user_indexes
  `);
  const bloated = rows.filter((r) => Number(r.index_bytes) > 100 * 1024 * 1024);
  if (bloated.length === 0) return "No bloated indexes found.";
  return (
    "Large indexes (>100MB):\n" +
    bloated
      .map((r) => {
        const mb = Number(r.index_bytes) / (1024 * 1024);
        return `Index '${r.index}' on '${r.table}': ${mb.toFixed(1)}MB`;
      })
      .join("\n")
  );
}

async function connectionHealth(db?: string): Promise<string> {
  const total = await query(db,`SELECT COUNT(*)::int AS count FROM pg_stat_activity`);
  const idle = await query(db,`SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE state = 'idle in transaction'`);
  const t = total[0]?.count ?? 0;
  const i = idle[0]?.count ?? 0;
  if (t > 500) return `High number of connections: ${t}`;
  if (i > 100) return `High number of connections idle in transaction: ${i}`;
  return `Connections healthy: ${t} total, ${i} idle`;
}

async function vacuumHealth(db?: string): Promise<string> {
  const rows = await query(db,`
    SELECT n.nspname AS schema, c.relname AS table,
      2146483648 - GREATEST(AGE(c.relfrozenxid), AGE(t.relfrozenxid)) AS transactions_left
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class t ON c.reltoastrelid = t.oid
    WHERE c.relkind = 'r'
      AND (2146483648 - GREATEST(AGE(c.relfrozenxid), AGE(t.relfrozenxid))) < 10000000
    ORDER BY 3, 1, 2
  `);
  if (rows.length === 0) return "All tables have healthy transaction ID age.";
  return (
    "Tables approaching transaction ID wraparound:\n" +
    rows.map((r) => `${r.schema}.${r.table}: ${r.transactions_left} transactions remaining`).join("\n")
  );
}

async function sequenceHealth(db?: string): Promise<string> {
  const rows = await query(db,`
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
      s.relname AS sequence, format_type(a.atttypid, a.atttypmod) AS column_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attrdef d ON (a.attrelid, a.attnum) = (d.adrelid, d.adnum)
    JOIN pg_class s ON s.oid = pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname)::regclass
    WHERE a.attnum > 0 AND NOT a.attisdropped AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%'
  `);
  const warnings: string[] = [];
  for (const row of rows) {
    const seq = `${row.schema}.${row.sequence}`;
    try {
      const last = await query(db,`SELECT last_value FROM ${seq}`);
      const max = row.column_type?.toString().includes("bigint") ? 9223372036854775807 : 2147483647;
      const used = Number(last[0]?.last_value ?? 0) / max;
      if (used > 0.9) warnings.push(`Sequence ${seq} for ${row.table}.${row.column} at ${(used * 100).toFixed(1)}%`);
    } catch {
      continue;
    }
  }
  return warnings.length === 0 ? "All sequences have healthy usage levels." : warnings.join("\n");
}

async function replicationHealth(db?: string): Promise<string> {
  const replica = await query(db,`SELECT pg_is_in_recovery() AS is_replica`);
  const isReplica = replica[0]?.is_replica === true;
  const lines: string[] = [isReplica ? "This is a replica database." : "This is a primary database."];
  if (isReplica) {
    const lag = await query(db,`SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) AS lag`);
    const seconds = lag[0]?.lag;
    lines.push(seconds != null ? `Replication lag: ${Number(seconds).toFixed(1)} seconds` : "No replication lag detected.");
  }
  const slots = await query(db,`SELECT slot_name, database, active FROM pg_replication_slots`);
  if (slots.length === 0) lines.push("No replication slots found.");
  else {
    for (const s of slots) lines.push(`Slot ${s.slot_name} (${s.database}): ${s.active ? "active" : "inactive"}`);
  }
  return lines.join("\n");
}

async function bufferHealth(db?: string): Promise<string> {
  const idx = await query(db,`
    SELECT (sum(idx_blks_hit)) / nullif(sum(idx_blks_hit + idx_blks_read), 0) AS rate FROM pg_statio_user_indexes
  `);
  const tbl = await query(db,`
    SELECT sum(heap_blks_hit) / nullif(sum(heap_blks_hit + heap_blks_read), 0) AS rate FROM pg_statio_user_tables
  `);
  const idxRate = Number(idx[0]?.rate ?? 0) * 100;
  const tblRate = Number(tbl[0]?.rate ?? 0) * 100;
  return [
    idxRate >= 95
      ? `Index cache hit rate: ${idxRate.toFixed(1)}% (above 95% threshold)`
      : `Index cache hit rate: ${idxRate.toFixed(1)}% (below 95% threshold)`,
    tblRate >= 95
      ? `Table cache hit rate: ${tblRate.toFixed(1)}% (above 95% threshold)`
      : `Table cache hit rate: ${tblRate.toFixed(1)}% (below 95% threshold)`,
  ].join("\n");
}

async function constraintHealth(db?: string): Promise<string> {
  const rows = await query(db,`
    SELECT nsp.nspname AS schema, rel.relname AS table, con.conname AS name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = con.connamespace
    WHERE con.convalidated = false
  `);
  if (rows.length === 0) return "No invalid constraints found.";
  return "Invalid constraints found:\n" + rows.map((r) => `${r.schema}.${r.table}: ${r.name}`).join("\n");
}

export async function analyzeDbHealth(healthType: string, db?: string) {
  try {
    const types = healthType.split(",").map((t) => t.trim());
    for (const t of types) {
      if (!HEALTH_TYPES.includes(t as HealthType)) {
        return error(`Invalid health type '${t}'. Valid: ${HEALTH_TYPES.join(", ")}`);
      }
    }
    const selected = types.includes("all")
      ? HEALTH_TYPES.filter((t) => t !== "all")
      : (types as HealthType[]);
    const parts: string[] = [];
    for (const t of selected) {
      if (t === "index") {
        parts.push("Invalid index check: " + (await invalidIndexes(db)));
        parts.push("Duplicate index check: " + (await duplicateIndexes(db)));
        parts.push("Index bloat: " + (await indexBloat(db)));
        parts.push("Unused index check: " + (await unusedIndexes(db)));
      } else if (t === "connection") parts.push("Connection health: " + (await connectionHealth(db)));
      else if (t === "vacuum") parts.push("Vacuum health: " + (await vacuumHealth(db)));
      else if (t === "sequence") parts.push("Sequence health: " + (await sequenceHealth(db)));
      else if (t === "replication") parts.push("Replication health: " + (await replicationHealth(db)));
      else if (t === "buffer") parts.push("Buffer health:\n" + (await bufferHealth(db)));
      else if (t === "constraint") parts.push("Constraint health: " + (await constraintHealth(db)));
    }
    return text(parts.join("\n"));
  } catch (e) {
    return error(String(e));
  }
}
