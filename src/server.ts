import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AccessMode } from "./db.js";
import { dbField } from "./params.js";
import { listDatabases } from "./tools/databases.js";
import { analyzeDbHealth } from "./tools/health.js";
import { analyzeQueryIndexes, analyzeWorkloadIndexes } from "./tools/indexes.js";
import { explainQuery } from "./tools/explain.js";
import { getObjectDetails, listObjects, listSchemas } from "./tools/schema.js";
import { executeSql } from "./tools/sql.js";
import { getTopQueries, getTopResourceQueries } from "./tools/top-queries.js";

export function createServer(accessMode: AccessMode): McpServer {
  const server = new McpServer({ name: "postgres-mcp", version: "0.3.0" });

  server.registerTool(
    "list_databases",
    { description: "List configured database connections. Call first when unsure which db to use.", inputSchema: {} },
    listDatabases
  );

  server.registerTool(
    "list_schemas",
    {
      description: "List schemas (user schemas only by default)",
      inputSchema: { db: dbField, include_system: z.boolean().default(false) },
    },
    async ({ db, include_system }) => listSchemas(db, !include_system)
  );

  server.registerTool(
    "list_objects",
    {
      description: "List tables, views, sequences, or extensions in a schema",
      inputSchema: {
        db: dbField,
        schema_name: z.string(),
        object_type: z.enum(["table", "view", "sequence", "extension"]).default("table"),
      },
    },
    async ({ db, schema_name, object_type }) => listObjects(schema_name, object_type, db)
  );

  server.registerTool(
    "get_object_details",
    {
      description: "Columns and indexes for a table/view",
      inputSchema: {
        db: dbField,
        schema_name: z.string(),
        object_name: z.string(),
        object_type: z.enum(["table", "view", "sequence", "extension"]).default("table"),
      },
    },
    async ({ db, schema_name, object_name, object_type }) =>
      getObjectDetails(schema_name, object_name, object_type, db)
  );

  const sqlDesc =
    accessMode === "restricted"
      ? "Execute read-only SQL (max 50 rows returned)"
      : "Execute SQL (max 50 rows returned)";

  server.registerTool(
    "execute_sql",
    {
      description: sqlDesc,
      inputSchema: {
        db: dbField,
        sql: z.string(),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    async ({ db, sql, limit }) => executeSql(sql, db, limit)
  );

  server.registerTool(
    "explain_query",
    {
      description: "EXPLAIN a SQL query, optionally with hypothetical indexes",
      inputSchema: {
        db: dbField,
        sql: z.string(),
        analyze: z.boolean().default(false),
        hypothetical_indexes: z
          .array(z.object({ table: z.string(), columns: z.array(z.string()), using: z.string().optional() }))
          .default([]),
      },
    },
    async ({ db, sql, analyze, hypothetical_indexes }) =>
      explainQuery(sql, analyze, hypothetical_indexes, db)
  );

  server.registerTool(
    "get_top_queries",
    {
      description: "Slow or resource-heavy queries from pg_stat_statements",
      inputSchema: {
        db: dbField,
        sort_by: z.enum(["resources", "mean_time", "total_time"]).default("resources"),
        limit: z.number().int().min(1).max(100).default(10),
      },
    },
    async ({ db, sort_by, limit }) => {
      if (sort_by === "resources") return getTopResourceQueries(0.05, db);
      if (sort_by === "total_time") return getTopQueries("total_time", limit, db);
      return getTopQueries("mean_time", limit, db);
    }
  );

  server.registerTool(
    "analyze_workload_indexes",
    {
      description: "Recommend indexes based on pg_stat_statements workload",
      inputSchema: { db: dbField, max_index_size_mb: z.number().default(-1) },
    },
    async ({ db, max_index_size_mb }) => analyzeWorkloadIndexes(max_index_size_mb, db)
  );

  server.registerTool(
    "analyze_query_indexes",
    {
      description: "Recommend indexes for up to 10 specific queries",
      inputSchema: {
        db: dbField,
        queries: z.array(z.string()).min(1).max(10),
        max_index_size_mb: z.number().default(-1),
      },
    },
    async ({ db, queries, max_index_size_mb }) => analyzeQueryIndexes(queries, max_index_size_mb, db)
  );

  server.registerTool(
    "analyze_db_health",
    {
      description: "Health checks: index,connection,vacuum,sequence,replication,buffer,constraint,all",
      inputSchema: { db: dbField, health_type: z.string().default("all") },
    },
    async ({ db, health_type }) => analyzeDbHealth(health_type, db)
  );

  return server;
}
