# postgres-mcp

Multi-DB Postgres MCP Server für Cursor / andere MCP-Clients.  
Unterstützt Schema-Exploration, sicheres SQL, EXPLAIN, Health-Checks und Index-Empfehlungen.

## Voraussetzungen

- Node.js 22+
- Postgres-Zugang (Connection-URI)
- Optional: Docker

Empfohlene Postgres-Extensions (für Slow-Queries / Index-Tuning):

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS hypopg;
```

`pg_stat_statements` muss zusätzlich in `shared_preload_libraries` aktiv sein und Postgres neu gestartet werden.

## Schnellstart (lokal)

```bash
npm install
npm run build
```

Eine DB:

```bash
DATABASE_URL='postgresql://user:pass@host:5432/dbname' \
ACCESS_MODE=restricted \
npm start
```

Mehrere DBs:

```bash
DB_STAGING_URL='postgresql://user:pass@host:5432/staging' \
DB_PROD_URL='postgresql://user:pass@host:5432/prod' \
DEFAULT_DB=staging \
ACCESS_MODE=restricted \
npm start
```

HTTP-Transport (für Docker / Remote):

```bash
npm run start:http
# -> http://0.0.0.0:8000/mcp
# Health: http://0.0.0.0:8000/health
```

## Konfiguration

### Datenbanken

| Variable | Beschreibung |
|---|---|
| `DATABASE_URL` | Einzelne DB (Alias `default`) |
| `DB_<NAME>_URL` | Multi-DB, z. B. `DB_STAGING_URL`, `DB_PROD_URL` |
| `DATABASES` | Alternativ: `staging\|url,prod\|url` oder JSON `{"staging":"url"}` |
| `DEFAULT_DB` | Default-Alias, wenn mehrere DBs konfiguriert sind |

Tools akzeptieren optional `db` (Alias aus `list_databases`). Ohne Angabe wird `DEFAULT_DB` verwendet.

### Access Mode

| Wert | Bedeutung |
|---|---|
| `unrestricted` | Read/Write (Default, für Dev) |
| `restricted` | Read-only, 30s Statement-Timeout, kein `COMMIT`/`ROLLBACK` |

Setzen über Env oder CLI:

```bash
ACCESS_MODE=restricted
# oder
node dist/index.js --access-mode=restricted
```

### Transport

| Variable / Flag | Default | Beschreibung |
|---|---|---|
| `TRANSPORT` / `--transport=` | `stdio` | `stdio` oder `http` |
| `HOST` / `--host=` | `0.0.0.0` | HTTP Bind-Adresse |
| `PORT` / `--port=` | `8000` | HTTP Port |

## Cursor einbinden

### Stdio (lokal)

In Cursor MCP Settings / `mcp.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": [
        "/ABSOLUTER/PFAD/postgres-mcp/dist/index.js",
        "--access-mode=restricted"
      ],
      "env": {
        "DB_STAGING_URL": "postgresql://user:pass@host:5432/staging",
        "DB_PROD_URL": "postgresql://user:pass@host:5432/prod",
        "DEFAULT_DB": "staging"
      }
    }
  }
}
```

Vorher einmal `npm run build` ausführen.

### HTTP (Docker / Remote)

```json
{
  "mcpServers": {
    "postgres": {
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

## Docker

Build:

```bash
docker build -t postgres-mcp .
```

Run:

```bash
docker run --rm -p 8000:8000 \
  -e ACCESS_MODE=restricted \
  -e DEFAULT_DB=staging \
  -e DB_STAGING_URL='postgresql://user:pass@host:5432/staging' \
  -e DB_PROD_URL='postgresql://user:pass@host:5432/prod' \
  postgres-mcp
```

Endpoints:

- MCP: `http://localhost:8000/mcp`
- Health: `http://localhost:8000/health`

Hinweis: Wenn Postgres auf dem Host läuft, `localhost` in der URI je nach OS durch `host.docker.internal` ersetzen.

## Tools

| Tool | Zweck |
|---|---|
| `list_databases` | Konfigurierte DB-Aliase anzeigen |
| `list_schemas` | Schemas listen |
| `list_objects` | Tables / Views / Sequences / Extensions |
| `get_object_details` | Spalten + Indexes eines Objekts |
| `execute_sql` | SQL ausführen (max. 50 Rows default) |
| `explain_query` | EXPLAIN / EXPLAIN ANALYZE / hypopg |
| `get_top_queries` | Slow Queries (`pg_stat_statements`) |
| `analyze_workload_indexes` | Index-Empfehlungen aus Workload |
| `analyze_query_indexes` | Index-Empfehlungen für konkrete Queries |
| `analyze_db_health` | Health: index, connection, vacuum, sequence, replication, buffer, constraint, all |

Typischer KI-Flow:

1. `list_databases`
2. `list_schemas` / `list_objects`
3. `get_object_details`
4. `execute_sql` mit `db: "staging"`

## Tests

Read-only Integrationstests gegen eine echte DB:

```bash
export TEST_DATABASE_URL='postgresql://user:pass@host:5432/dbname'
npm test
```

Die Tests laufen im `restricted`-Mode und prüfen alle Tools inkl. Multi-DB und Error-Cases.

Vorlage: `.env.test.example`

## Entwicklung

```bash
npm install
npm run build
npm start
npm run start:http
npm test
```

Build-Output liegt in `dist/`.