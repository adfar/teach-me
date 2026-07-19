import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

const dataDirectory = path.join(process.cwd(), "data");
mkdirSync(dataDirectory, { recursive: true });

const globalForDatabase = globalThis as unknown as {
  teachMeSqlite?: InstanceType<typeof Database>;
};

const sqlite =
  globalForDatabase.teachMeSqlite ??
  new Database(path.join(dataDirectory, "teach-me.db"));

if (process.env.NODE_ENV !== "production") {
  globalForDatabase.teachMeSqlite = sqlite;
}

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
