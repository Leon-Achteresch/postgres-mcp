import { query } from "../db.js";
import { error, text } from "../response.js";

export async function listSchemas(db?: string, userOnly = true) {
  try {
    const filter = userOnly
      ? "WHERE schema_name NOT LIKE 'pg_%' AND schema_name != 'information_schema'"
      : "";
    const rows = await query(
      db,
      `SELECT schema_name FROM information_schema.schemata ${filter} ORDER BY schema_name`
    );
    return text(rows.map((r) => r.schema_name));
  } catch (e) {
    return error(String(e));
  }
}

export async function listObjects(schemaName: string, objectType: string, db?: string) {
  try {
    if (objectType === "table" || objectType === "view") {
      const tableType = objectType === "table" ? "BASE TABLE" : "VIEW";
      const rows = await query(
        db,
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = '${schemaName}' AND table_type = '${tableType}'
         ORDER BY table_name`
      );
      return text(rows.map((r) => r.table_name));
    }
    if (objectType === "sequence") {
      const rows = await query(
        db,
        `SELECT sequence_name FROM information_schema.sequences
         WHERE sequence_schema = '${schemaName}' ORDER BY sequence_name`
      );
      return text(rows.map((r) => r.sequence_name));
    }
    if (objectType === "extension") {
      const rows = await query(db, `SELECT extname FROM pg_extension ORDER BY extname`);
      return text(rows.map((r) => r.extname));
    }
    return error(`Unsupported object type: ${objectType}`);
  } catch (e) {
    return error(String(e));
  }
}

export async function getObjectDetails(
  schemaName: string,
  objectName: string,
  objectType: string,
  db?: string
) {
  try {
    if (objectType === "table" || objectType === "view") {
      const columns = await query(
        db,
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = '${schemaName}' AND table_name = '${objectName}'
         ORDER BY ordinal_position`
      );
      const indexes = await query(
        db,
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = '${schemaName}' AND tablename = '${objectName}'`
      );
      return text({
        schema: schemaName,
        name: objectName,
        type: objectType,
        columns,
        indexes: indexes.map((r) => r.indexname),
      });
    }
    if (objectType === "sequence") {
      const rows = await query(
        db,
        `SELECT data_type, start_value, increment FROM information_schema.sequences
         WHERE sequence_schema = '${schemaName}' AND sequence_name = '${objectName}'`
      );
      return text(rows[0] ?? {});
    }
    if (objectType === "extension") {
      const rows = await query(db, `SELECT extversion FROM pg_extension WHERE extname = '${objectName}'`);
      return text(rows[0] ?? {});
    }
    return error(`Unsupported object type: ${objectType}`);
  } catch (e) {
    return error(String(e));
  }
}
