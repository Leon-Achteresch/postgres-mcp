import { query } from "../db.js";
import { error, rows } from "../response.js";

export async function executeSql(sql: string, db?: string, limit = 50) {
  try {
    const result = await query(db, sql);
    if (result.length <= limit) return rows(result);
    return rows(result.slice(0, limit), { total: result.length, truncated: result.length - limit });
  } catch (e) {
    return error(String(e));
  }
}
