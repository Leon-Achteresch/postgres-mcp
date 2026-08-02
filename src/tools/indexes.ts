import { checkExtension, getPostgresVersion, hypopgStatus, pgStatColumns, PG_STAT_MSG } from "../extensions.js";
import { query } from "../db.js";
import { error, text } from "../response.js";
import { indexDef, planCost } from "./explain.js";

const MAX_QUERIES = 10;
const MIN_IMPROVEMENT = 0.1;

type IndexCandidate = { table: string; columns: string[]; using: string };

function extractCandidates(sql: string): IndexCandidate[] {
  const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+"?(\w+)"?/gi)].map((m) => m[1]);
  const cols = [...sql.matchAll(/\b(\w+)\s*(?:=|<|>|<=|>=|<>|!=|IN|LIKE)\b/gi)].map((m) => m[1]);
  const orderCols = [...sql.matchAll(/\bORDER\s+BY\s+([\w",\s]+)/gi)].flatMap((m) =>
    m[1].split(",").map((c) => c.trim().replace(/"/g, ""))
  );
  const allCols = [...new Set([...cols, ...orderCols].filter((c) => c && !/^(AND|OR|ON|BY)$/i.test(c)))];
  const candidates: IndexCandidate[] = [];
  for (const table of [...new Set(tables)]) {
    for (const col of allCols) candidates.push({ table, columns: [col], using: "btree" });
    if (allCols.length >= 2) candidates.push({ table, columns: allCols.slice(0, 2), using: "btree" });
  }
  return candidates;
}

async function explainCost(db: string | undefined, sql: string, indexes: IndexCandidate[]): Promise<number> {
  let setup = "SELECT hypopg_reset();";
  for (const idx of indexes) {
    setup += `SELECT hypopg_create_index('${indexDef(idx).replace(/'/g, "''")}');`;
  }
  const rows = await query(db, `${setup} EXPLAIN (FORMAT JSON) ${sql}`);
  const plan = rows[0]?.["QUERY PLAN"];
  return planCost(Array.isArray(plan) ? plan[0] : plan);
}

async function estimateIndexSize(db: string | undefined, idx: IndexCandidate): Promise<number> {
  await query(db, "SELECT hypopg_reset();");
  await query(db, `SELECT hypopg_create_index('${indexDef(idx).replace(/'/g, "''")}');`);
  const rows = await query(db, "SELECT hypopg_relation_size(indexrelid) AS size FROM hypopg_list_indexes LIMIT 1");
  await query(db, "SELECT hypopg_reset();");
  return Number(rows[0]?.size ?? 0);
}

async function analyzeQueries(db: string | undefined, queries: string[], maxIndexSizeMb: number) {
  const hypo = await hypopgStatus(db);
  if (!hypo.ok) return hypo.message;

  const budgetBytes = maxIndexSizeMb > 0 ? maxIndexSizeMb * 1024 * 1024 : Infinity;
  const results: string[] = [];

  for (const sql of queries.slice(0, MAX_QUERIES)) {
    const baseline = await explainCost(db, sql, []);
    const candidates = extractCandidates(sql);
    const selected: IndexCandidate[] = [];
    let currentCost = baseline;
    let usedBytes = 0;

    while (candidates.length > 0) {
      let best: IndexCandidate | null = null;
      let bestCost = currentCost;
      for (const candidate of candidates) {
        const cost = await explainCost(db, sql, [...selected, candidate]);
        if (cost < bestCost) {
          best = candidate;
          bestCost = cost;
        }
      }
      if (!best) break;
      const improvement = (currentCost - bestCost) / currentCost;
      if (improvement < MIN_IMPROVEMENT) break;
      const size = await estimateIndexSize(db, best);
      if (usedBytes + size > budgetBytes) break;
      selected.push(best);
      usedBytes += size;
      currentCost = bestCost;
      candidates.splice(candidates.indexOf(best), 1);
    }

    results.push(
      `${sql.slice(0, 100)} | cost ${baseline.toFixed(0)}→${currentCost.toFixed(0)} | indexes: ${
        selected.length === 0 ? "none" : selected.map((i) => indexDef(i)).join("; ")
      }`
    );
  }
  return results.join("\n");
}

export async function analyzeQueryIndexes(queries: string[], maxIndexSizeMb = -1, db?: string) {
  try {
    if (queries.length === 0) return error("No queries provided");
    if (queries.length > MAX_QUERIES) return error(`Maximum ${MAX_QUERIES} queries allowed`);
    return text(await analyzeQueries(db, queries, maxIndexSizeMb));
  } catch (e) {
    return error(String(e));
  }
}

export async function analyzeWorkloadIndexes(maxIndexSizeMb = -1, db?: string) {
  try {
    const ext = await checkExtension("pg_stat_statements", db);
    if (!ext.installed) return text(PG_STAT_MSG);
    const version = await getPostgresVersion(db);
    const cols = pgStatColumns(version);
    const rows = await query(
      db,
      `SELECT query FROM pg_stat_statements ORDER BY ${cols.total} DESC NULLS LAST LIMIT ${MAX_QUERIES}`
    );
    const queries = rows.map((r) => String(r.query)).filter(Boolean);
    if (queries.length === 0) return text("No queries in pg_stat_statements");
    return text(await analyzeQueries(db, queries, maxIndexSizeMb));
  } catch (e) {
    return error(String(e));
  }
}
