import { hypopgStatus } from "../extensions.js";
import { query } from "../db.js";
import { error, text } from "../response.js";

type HypotheticalIndex = { table: string; columns: string[]; using?: string };

function indexDef(idx: HypotheticalIndex): string {
  const method = idx.using ?? "btree";
  const cols = idx.columns.map((c) => `"${c}"`).join(", ");
  return `CREATE INDEX ON "${idx.table}" USING ${method} (${cols})`;
}

export function planCost(plan: unknown): number {
  if (!plan || typeof plan !== "object") return Infinity;
  const p = plan as Record<string, unknown>;
  if (typeof p["Total Cost"] === "number") return p["Total Cost"];
  const inner = p.Plan as Record<string, unknown> | undefined;
  if (inner && typeof inner["Total Cost"] === "number") return inner["Total Cost"];
  return Infinity;
}

async function runExplain(db: string | undefined, sql: string, analyze: boolean): Promise<unknown> {
  const opts = ["FORMAT JSON"];
  if (analyze) opts.push("ANALYZE");
  const result = await query(db, `EXPLAIN (${opts.join(", ")}) ${sql}`);
  const plan = result[0]?.["QUERY PLAN"];
  return Array.isArray(plan) ? plan[0] : plan;
}

export async function explainQuery(
  sql: string,
  analyze = false,
  hypotheticalIndexes: HypotheticalIndex[] = [],
  db?: string
) {
  try {
    if (analyze && hypotheticalIndexes.length > 0) {
      return error("Cannot use analyze and hypothetical indexes together");
    }
    if (hypotheticalIndexes.length > 0) {
      const status = await hypopgStatus(db);
      if (!status.ok) return text(status.message);
      let setup = "SELECT hypopg_reset();";
      for (const idx of hypotheticalIndexes) {
        setup += `SELECT hypopg_create_index('${indexDef(idx).replace(/'/g, "''")}');`;
      }
      const result = await query(db, `${setup} EXPLAIN (FORMAT JSON) ${sql}`);
      const plan = result[0]?.["QUERY PLAN"];
      return text(Array.isArray(plan) ? plan[0] : plan);
    }
    return text(await runExplain(db, sql, analyze));
  } catch (e) {
    return error(String(e));
  }
}

export { indexDef };
