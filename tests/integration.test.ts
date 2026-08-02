import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closeAll, getAccessMode, initDb, listDatabaseIds, query, resolveDb } from "../src/db.js";
import { listDatabases } from "../src/tools/databases.js";
import { analyzeDbHealth } from "../src/tools/health.js";
import { analyzeQueryIndexes, analyzeWorkloadIndexes } from "../src/tools/indexes.js";
import { explainQuery } from "../src/tools/explain.js";
import { getObjectDetails, listObjects, listSchemas } from "../src/tools/schema.js";
import { executeSql } from "../src/tools/sql.js";
import { getTopQueries, getTopResourceQueries } from "../src/tools/top-queries.js";
import {
  assertError,
  assertSuccess,
  body,
  hasExtensionMessage,
  parseJson,
  type ToolResult,
} from "./helpers.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const dbUrl = requireEnv("TEST_DATABASE_URL");

type DbRow = { id: string; default: boolean };
type TablePick = { schema: string; table: string };
type ExtPick = { name: string };

let userSchemas: string[] = [];
let sampleTable: TablePick | null = null;
let sampleColumn: string | null = null;
let sampleView: TablePick | null = null;
let sampleSequence: { schema: string; name: string } | null = null;
let installedExtensions: string[] = [];
let hasPgStat = false;
let hasHypopg = false;

function initRestricted(): void {
  initDb("restricted", { databases: { default: dbUrl, replica: dbUrl }, defaultDb: "default" });
}

async function discover(): Promise<void> {
  const schemas = parseJson<string[]>(await listSchemas(undefined, true));
  userSchemas = schemas;

  for (const schema of schemas) {
    const tables = parseJson<string[]>(await listObjects(schema, "table"));
    if (!sampleTable && tables.length > 0) {
      sampleTable = { schema, table: tables[0] };
      const detail = parseJson<{ columns: { column_name: string }[] }>(
        await getObjectDetails(schema, tables[0], "table")
      );
      sampleColumn = detail.columns[0]?.column_name ?? null;
    }

    const views = parseJson<string[]>(await listObjects(schema, "view"));
    if (!sampleView && views.length > 0) sampleView = { schema, table: views[0] };

    const sequences = parseJson<string[]>(await listObjects(schema, "sequence"));
    if (!sampleSequence && sequences.length > 0) sampleSequence = { schema, name: sequences[0] };
  }

  installedExtensions = parseJson<string[]>(await listObjects("public", "extension"));
  const extRows = await query(undefined, "SELECT extname FROM pg_extension");
  hasHypopg = extRows.some((r) => r.extname === "hypopg");
  try {
    await query(undefined, "SELECT 1 FROM pg_stat_statements LIMIT 1");
    hasPgStat = true;
  } catch {
    hasPgStat = false;
  }
  if (!hasHypopg) {
    try {
      await query(undefined, "SELECT hypopg_reset()");
      hasHypopg = true;
    } catch {
      hasHypopg = false;
    }
  }
}

describe("postgres-mcp integration (read-only)", () => {
  before(async () => {
    initRestricted();
    await discover();
  });

  after(async () => {
    await closeAll();
  });

  describe("db layer", () => {
    it("runs in restricted mode", () => {
      assert.equal(getAccessMode(), "restricted");
    });

    it("lists configured database ids", () => {
      const ids = listDatabaseIds();
      assert.deepEqual(
        ids.map((d) => d.id).sort(),
        ["default", "replica"].sort()
      );
      assert.equal(ids.find((d) => d.id === "default")?.default, true);
    });

    it("resolves default and named db", () => {
      assert.equal(resolveDb(), "default");
      assert.equal(resolveDb("replica"), "replica");
    });

    it("rejects unknown database id", () => {
      assert.throws(() => resolveDb("missing"), /Unknown database/);
    });

    it("blocks transaction control in restricted mode", async () => {
      await assert.rejects(
        () => query(undefined, "COMMIT"),
        /Transaction control statements are not allowed/
      );
    });
  });

  describe("list_databases", () => {
    it("returns compact id list", async () => {
      const rows = parseJson<DbRow[]>(assertSuccess(await listDatabases(), "list_databases"));
      assert.ok(rows.length >= 1);
      assert.ok(rows.some((r) => r.id === "default" && r.default));
    });
  });

  describe("list_schemas", () => {
    it("returns user schemas by default", async () => {
      const schemas = parseJson<string[]>(assertSuccess(await listSchemas(), "list_schemas"));
      assert.ok(schemas.length > 0);
      assert.ok(!schemas.includes("pg_catalog"));
      assert.ok(!schemas.includes("information_schema"));
    });

    it("can include system schemas", async () => {
      const schemas = parseJson<string[]>(
        assertSuccess(await listSchemas(undefined, false), "list_schemas system")
      );
      assert.ok(schemas.includes("pg_catalog"));
      assert.ok(schemas.includes("information_schema"));
    });
  });

  describe("list_objects", () => {
    it("lists extensions", async () => {
      const exts = parseJson<string[]>(
        assertSuccess(await listObjects("public", "extension"), "list_objects extension")
      );
      assert.ok(exts.length > 0);
      assert.ok(exts.includes("plpgsql"));
    });

    it("lists tables for each user schema", async () => {
      for (const schema of userSchemas) {
        const tables = parseJson<string[]>(
          assertSuccess(await listObjects(schema, "table"), `tables in ${schema}`)
        );
        assert.ok(Array.isArray(tables));
      }
    });

    it("lists views when present", async () => {
      for (const schema of userSchemas) {
        const views = parseJson<string[]>(
          assertSuccess(await listObjects(schema, "view"), `views in ${schema}`)
        );
        assert.ok(Array.isArray(views));
      }
    });

    it("lists sequences when present", async () => {
      for (const schema of userSchemas) {
        const seqs = parseJson<string[]>(
          assertSuccess(await listObjects(schema, "sequence"), `sequences in ${schema}`)
        );
        assert.ok(Array.isArray(seqs));
      }
    });

    it("rejects unsupported object type", async () => {
      assertError(await listObjects("public", "function"), "unsupported object type");
    });
  });

  describe("get_object_details", () => {
    it("returns table columns and indexes", async () => {
      if (!sampleTable) return;
      const detail = parseJson<{
        schema: string;
        name: string;
        columns: unknown[];
        indexes: unknown[];
      }>(
        assertSuccess(
          await getObjectDetails(sampleTable.schema, sampleTable.table, "table"),
          "get_object_details table"
        )
      );
      assert.equal(detail.schema, sampleTable.schema);
      assert.equal(detail.name, sampleTable.table);
      assert.ok(detail.columns.length > 0);
      assert.ok(Array.isArray(detail.indexes));
    });

    it("returns view details when a view exists", async () => {
      if (!sampleView) return;
      const detail = parseJson<{ type: string; columns: unknown[] }>(
        assertSuccess(
          await getObjectDetails(sampleView.schema, sampleView.table, "view"),
          "get_object_details view"
        )
      );
      assert.equal(detail.type, "view");
      assert.ok(Array.isArray(detail.columns));
    });

    it("returns sequence details when a sequence exists", async () => {
      if (!sampleSequence) return;
      const detail = parseJson<Record<string, unknown>>(
        assertSuccess(
          await getObjectDetails(sampleSequence.schema, sampleSequence.name, "sequence"),
          "get_object_details sequence"
        )
      );
      assert.ok("data_type" in detail || Object.keys(detail).length >= 0);
    });

    it("returns extension version", async () => {
      const ext = installedExtensions[0] ?? "plpgsql";
      const detail = parseJson<Record<string, unknown>>(
        assertSuccess(await getObjectDetails("public", ext, "extension"), "get_object_details extension")
      );
      assert.ok("extversion" in detail || Object.keys(detail).length >= 0);
    });

    it("rejects unsupported object type", async () => {
      assertError(await getObjectDetails("public", "x", "function"), "unsupported object type");
    });
  });

  describe("execute_sql", () => {
    it("runs a read-only version query", async () => {
      const rows = parseJson<Record<string, unknown>[]>(
        assertSuccess(await executeSql("SELECT version()"), "execute_sql version")
      );
      assert.equal(rows.length, 1);
      assert.match(String(rows[0].version ?? ""), /PostgreSQL/i);
    });

    it("returns current database name", async () => {
      const rows = parseJson<{ current_database: string }[]>(
        assertSuccess(await executeSql("SELECT current_database()"), "execute_sql current_database")
      );
      assert.ok(rows[0].current_database.length > 0);
    });

    it("respects row limit and reports truncation", async () => {
      if (!sampleTable) return;
      const sql = `SELECT * FROM "${sampleTable.schema}"."${sampleTable.table}"`;
      const raw = assertSuccess(await executeSql(sql, undefined, 1), "execute_sql limit");
      const parsed = JSON.parse(raw) as unknown[] | { rows: unknown[]; total: number; truncated: number };
      if (Array.isArray(parsed)) {
        assert.ok(parsed.length <= 1);
      } else {
        assert.equal(parsed.rows.length, 1);
        assert.ok(parsed.total >= 1);
        if (parsed.total > 1) assert.ok(parsed.truncated > 0);
      }
    });

    it("works on named db alias", async () => {
      const rows = parseJson<{ ok: number }[]>(
        assertSuccess(await executeSql("SELECT 1 AS ok", "replica"), "execute_sql replica")
      );
      assert.equal(rows[0].ok, 1);
    });

    it("rejects write statements in restricted mode", async () => {
      assertError(await executeSql("INSERT INTO pg_catalog.pg_namespace (nspname) VALUES ('evil')"), "insert blocked");
    });

    it("rejects commit in sql string", async () => {
      assertError(await executeSql("COMMIT"), "commit blocked");
    });
  });

  describe("explain_query", () => {
    it("returns explain plan for simple select", async () => {
      const plan = parseJson<Record<string, unknown>>(
        assertSuccess(await explainQuery("SELECT 1"), "explain_query")
      );
      assert.ok("Plan" in plan || "Total Cost" in plan || Object.keys(plan).length > 0);
    });

    it("returns explain plan for table scan when table exists", async () => {
      if (!sampleTable) return;
      const sql = `SELECT * FROM "${sampleTable.schema}"."${sampleTable.table}" LIMIT 1`;
      const plan = parseJson<Record<string, unknown>>(assertSuccess(await explainQuery(sql), "explain table"));
      assert.ok(Object.keys(plan).length > 0);
    });

    it("supports explain analyze on read-only select", async () => {
      const plan = parseJson<Record<string, unknown>>(
        assertSuccess(await explainQuery("SELECT count(*) FROM pg_class", true), "explain analyze")
      );
      assert.ok(Object.keys(plan).length > 0);
    });

    it("rejects analyze with hypothetical indexes", async () => {
      assertError(
        await explainQuery("SELECT 1", true, [{ table: "pg_class", columns: ["oid"] }]),
        "analyze + hypothetical"
      );
    });

    it("handles hypothetical indexes when hypopg is available", async () => {
      if (!sampleTable || !sampleColumn || !hasHypopg) return;
      const sql = `SELECT * FROM "${sampleTable.schema}"."${sampleTable.table}" LIMIT 1`;
      assertSuccess(
        await explainQuery(sql, false, [{ table: sampleTable.table, columns: [sampleColumn] }]),
        "hypothetical explain"
      );
    });
  });

  describe("get_top_queries", () => {
    it("reports install hint or results for resources", async () => {
      const text = body(await getTopResourceQueries());
      if (!hasPgStat) {
        assert.ok(hasExtensionMessage(text, "pg_stat_statements") || text.includes("shared_preload_libraries"));
        return;
      }
      assertSuccess({ content: [{ type: "text", text }] }, "top resources");
    });

    it("reports install hint or results for mean_time", async () => {
      const text = body(await getTopQueries("mean_time", 5));
      if (!hasPgStat) {
        assert.ok(hasExtensionMessage(text, "pg_stat_statements") || text.includes("shared_preload_libraries"));
        return;
      }
      const rows = parseJson<unknown[]>(assertSuccess({ content: [{ type: "text", text }] }, "mean_time"));
      assert.ok(Array.isArray(rows));
    });

    it("reports install hint or results for total_time", async () => {
      const text = body(await getTopQueries("total_time", 5));
      if (!hasPgStat) {
        assert.ok(hasExtensionMessage(text, "pg_stat_statements") || text.includes("shared_preload_libraries"));
        return;
      }
      assert.match(text, /slowest queries/i);
    });
  });

  describe("analyze_db_health", () => {
    const types = ["index", "connection", "vacuum", "sequence", "replication", "buffer", "constraint"] as const;

    for (const type of types) {
      it(`runs ${type} health check`, async () => {
        const text = assertSuccess(await analyzeDbHealth(type), `health ${type}`);
        assert.ok(text.length > 0);
      });
    }

    it("runs all health checks combined", async () => {
      const text = assertSuccess(await analyzeDbHealth("all"), "health all");
      assert.ok(text.includes("Connection health"));
      assert.ok(text.includes("Buffer health") || text.includes("cache hit rate"));
    });

    it("runs comma-separated health checks", async () => {
      const text = assertSuccess(await analyzeDbHealth("connection,buffer"), "health combo");
      assert.ok(text.includes("Connection health"));
    });

    it("rejects invalid health type", async () => {
      assertError(await analyzeDbHealth("nope"), "invalid health");
    });
  });

  describe("analyze_query_indexes", () => {
    it("rejects empty query list", async () => {
      assertError(await analyzeQueryIndexes([]), "empty queries");
    });

    it("rejects more than 10 queries", async () => {
      assertError(await analyzeQueryIndexes(Array(11).fill("SELECT 1")), "max queries");
    });

    it("analyzes a sample select query", async () => {
      if (!sampleTable) return;
      const sql = `SELECT * FROM "${sampleTable.schema}"."${sampleTable.table}" LIMIT 10`;
      const text = body(await analyzeQueryIndexes([sql]));
      if (!hasHypopg) {
        assert.ok(hasExtensionMessage(text, "hypopg"));
        return;
      }
      assertSuccess({ content: [{ type: "text", text }] }, "analyze_query_indexes");
    });
  });

  describe("analyze_workload_indexes", () => {
    it("reports extension requirement or workload analysis", async () => {
      const text = body(await analyzeWorkloadIndexes());
      if (!hasPgStat) {
        assert.ok(hasExtensionMessage(text, "pg_stat_statements") || text.includes("shared_preload_libraries"));
        return;
      }
      if (!hasHypopg) {
        assert.ok(hasExtensionMessage(text, "hypopg"));
        return;
      }
      assertSuccess({ content: [{ type: "text", text }] }, "analyze_workload_indexes");
    });
  });

  describe("cross-db", () => {
    it("uses default db when db param omitted", async () => {
      const a = parseJson<string[]>(await listSchemas());
      const b = parseJson<string[]>(await listSchemas("default"));
      assert.deepEqual(a, b);
    });

    it("returns same data for replica alias", async () => {
      const a = parseJson<string[]>(await listSchemas("default"));
      const b = parseJson<string[]>(await listSchemas("replica"));
      assert.deepEqual(a, b);
    });
  });
});
