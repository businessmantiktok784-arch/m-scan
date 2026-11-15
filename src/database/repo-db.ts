/**
 * Shared adapter from the expo-sqlite handle to the repository seams'
 * structural `RepoDb`. The repository layer only ever binds
 * string/number/null values, so the casts are safe; they exist because
 * expo-sqlite's overloaded statement types do not line up structurally with
 * the repositories' narrower signatures.
 */
import type { SQLiteDatabase } from "expo-sqlite";
import type { RepoDb } from "./import-repository";

export function toRepoDb(db: SQLiteDatabase): RepoDb {
  return {
    runAsync: (sql: string, params?: unknown[]) => db.runAsync(sql, (params ?? []) as never),
    getFirstAsync: <T>(sql: string, params?: unknown[]) => db.getFirstAsync<T>(sql, (params ?? []) as never),
    getAllAsync: <T>(sql: string, params?: unknown[]) => db.getAllAsync<T>(sql, (params ?? []) as never),
  };
}
