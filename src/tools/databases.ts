import { listDatabaseIds } from "../db.js";
import { text } from "../response.js";

export async function listDatabases() {
  return text(listDatabaseIds());
}
