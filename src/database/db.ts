/**
 * SQLite persistence: the single offline database layer for the app.
 *
 * Migrations live in `./migrations` (pure, off-device testable) and run
 * through a small adapter; each migration is transactional and runs at most
 * once, tracked in `_migrations`.
 */
import { Platform } from "react-native";
import type * as SQLiteTypes from "expo-sqlite";

import { applyPendingMigrations, type MigrationAdapter } from "./migrations";

export type Database = SQLiteTypes.SQLiteDatabase;

let sqliteModule: typeof SQLiteTypes | null = null;

/**
 * Loads expo-sqlite lazily and native-only. Importing it at module top level
 * would pull expo-sqlite's web worker bundle into the web preview, which
 * crashes there ("window is not defined") before any of our code runs. The
 * web is not a supported target for this product: report that honestly
 * instead of crashing the whole bundle.
 */
function loadSQLite(): typeof SQLiteTypes {
  if (sqliteModule) return sqliteModule;
  if (Platform.OS === "web") {
    throw new Error(
      "Offline storage requires a native build (Android or iOS). The web preview cannot open the SQLite database."
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sqliteModule = require("expo-sqlite") as typeof SQLiteTypes;
  return sqliteModule;
}

let instance: Database | null = null;
let opening: Promise<Database> | null = null;

/** Bridges the expo-sqlite async handle to the migration runner's adapter. */
function expoAdapter(db: Database): MigrationAdapter {
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params) => {
      await db.runAsync(sql, params as SQLiteTypes.SQLiteBindParams);
    },
    getOne: (sql) => db.getFirstAsync<{ max: number | null }>(sql),
  };
}

export async function openDatabase(): Promise<Database> {
  if (instance) return instance;
  if (opening) return opening;

  opening = (async () => {
    const SQLite = loadSQLite();
    const db = await SQLite.openDatabaseAsync("mining_scanner.db");
    await db.execAsync(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
    await applyPendingMigrations(expoAdapter(db));
    instance = db;
    return db;
  })();

  try {
    return await opening;
  } catch (err) {
    opening = null;
    throw err;
  }
}

/** Test hook: forgets the cached handle so a fresh database can be opened. */
export function resetDatabaseHandle(): void {
  instance = null;
  opening = null;
}
