import { z } from "zod";

export const dbField = z.string().optional().describe("Database id from list_databases");
