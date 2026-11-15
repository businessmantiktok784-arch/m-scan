/**
 * Import repository — Stage 3.1 SQL for the point-cloud import lifecycle.
 *
 * Tables (migration v3):
 *   - `processing_operations` — provenance for every long-running operation
 *     (currently `pointcloud_import`); tool identity comes from the real app
 *     version, never a fabricated string.
 *   - `pointcloud_imports` — one row per import attempt. A row exists while
 *     the import runs so a crash can be reconciled to 'interrupted'; the
 *     `assets` row (the actual asset registry) is written in the SAME
 *     transaction that flips `import_status` to 'succeeded'. A failed or
 *     interrupted import therefore never registers as an asset.
 *
 * The repository depends on a structural database interface so the whole
 * lifecycle is testable off-device with bun:sqlite (see
 * tests/mobile/pointcloud-import.test.ts). Transactions are explicit
 * BEGIN/COMMIT via runAsync — the same statements work on expo-sqlite and
 * bun:sqlite alike.
 */
import type { ImportStatus, PointCloudImportRecord } from "../models/import";

/** Structural subset both expo-sqlite and the bun:sqlite test adapter expose. */
export interface RepoDb {
  runAsync(sql: string, params?: unknown[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface ImportRow {
  asset_id: string;
  project_id: string;
  operation_id: string;
  original_filename: string;
  stored_rel_path: string;
  format: string;
  byte_size: number;
  checksum_md5: string;
  validation_status: string;
  import_status: ImportStatus;
  point_count: number | null;
  meta_json: string;
  created_at: string;
  updated_at: string;
}

export const importRepository = {
  /**
   * Opens the operation: inserts the provenance row (status 'running') and
   * the import row (status 'importing') in one transaction.
   */
  async beginImport(db: RepoDb, input: {
    operation: {
      operation_id: string;
      project_id: string;
      input_ref: string;
      tool: string;
      tool_version: string;
      started_at: string;
    };
    import: PointCloudImportRecord;
  }): Promise<void> {
    await db.runAsync(`BEGIN IMMEDIATE`, []);
    try {
      await db.runAsync(
        `INSERT INTO processing_operations
           (operation_id, project_id, operation, status, input_ref, output_asset_id,
            tool, tool_version, message, detail_json, started_at, finished_at)
         VALUES (?, ?, 'pointcloud_import', 'running', ?, NULL, ?, ?, '', '{}', ?, NULL)`,
        [
          input.operation.operation_id,
          input.operation.project_id,
          input.operation.input_ref,
          input.operation.tool,
          input.operation.tool_version,
          input.operation.started_at,
        ]
      );
      await db.runAsync(
        `INSERT INTO pointcloud_imports
           (asset_id, project_id, operation_id, original_filename, stored_rel_path,
            format, byte_size, checksum_md5, validation_status, import_status,
            point_count, meta_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'importing', NULL, '{}', ?, ?)`,
        [
          input.import.asset_id,
          input.import.project_id,
          input.import.operation_id,
          input.import.original_filename,
          input.import.stored_rel_path,
          input.import.format,
          input.import.byte_size,
          input.import.checksum_md5,
          input.import.validation_status,
          input.import.created_at,
          input.import.updated_at,
        ]
      );
      await db.runAsync(`COMMIT`, []);
    } catch (err) {
      await db.runAsync(`ROLLBACK`, []);
      throw err;
    }
  },

  /**
   * Success path — atomic by contract: the assets row (kind 'pointcloud'),
   * the import-status flip and the operation close-out land together or
   * not at all.
   */
  async markSucceeded(db: RepoDb, input: {
    import: PointCloudImportRecord;
    asset: {
      asset_id: string;
      project_id: string;
      session_id: string | null;
      file_path: string;
      byte_size: number;
      meta_json: string;
      created_at: string;
    };
    message: string;
  }): Promise<void> {
    await db.runAsync(`BEGIN IMMEDIATE`, []);
    try {
      await db.runAsync(
        `INSERT INTO assets (asset_id, project_id, session_id, kind, file_path, byte_size, meta_json, created_at)
         VALUES (?, ?, ?, 'pointcloud', ?, ?, ?, ?)`,
        [
          input.asset.asset_id,
          input.asset.project_id,
          input.asset.session_id,
          input.asset.file_path,
          input.asset.byte_size,
          input.asset.meta_json,
          input.asset.created_at,
        ]
      );
      await db.runAsync(
        `UPDATE pointcloud_imports
         SET import_status = 'succeeded', validation_status = ?, point_count = ?, meta_json = ?, updated_at = ?
         WHERE asset_id = ?`,
        [
          input.import.validation_status,
          input.import.point_count,
          input.import.meta_json,
          input.import.updated_at,
          input.import.asset_id,
        ]
      );
      await db.runAsync(
        `UPDATE processing_operations
         SET status = 'done', output_asset_id = ?, message = ?, finished_at = ?
         WHERE operation_id = ?`,
        [input.import.asset_id, input.message, input.import.updated_at, input.import.operation_id]
      );
      await db.runAsync(`COMMIT`, []);
    } catch (err) {
      await db.runAsync(`ROLLBACK`, []);
      throw err;
    }
  },

  /** Failure/cancel path: import_status → 'failed'; the operation closes out. */
  async markFailed(db: RepoDb, input: {
    assetId: string;
    operationId: string;
    opStatus: "failed" | "cancelled";
    message: string;
    detailJson: string;
    at: string;
  }): Promise<void> {
    await db.runAsync(`BEGIN IMMEDIATE`, []);
    try {
      await db.runAsync(
        `UPDATE pointcloud_imports SET import_status = 'failed', meta_json = ?, updated_at = ? WHERE asset_id = ?`,
        [input.detailJson, input.at, input.assetId]
      );
      await db.runAsync(
        `UPDATE processing_operations
         SET status = ?, message = ?, detail_json = ?, finished_at = ? WHERE operation_id = ?`,
        [input.opStatus, input.message, input.detailJson, input.at, input.operationId]
      );
      await db.runAsync(`COMMIT`, []);
    } catch (err) {
      await db.runAsync(`ROLLBACK`, []);
      throw err;
    }
  },

  /**
   * Crash reconciliation: every row still 'importing' when no import is
   * actually running (checked by the caller) is marked 'interrupted' and its
   * operation 'failed'. Interrupted imports are NOT assets and NOT failures
   * of the file — the app or device stopped mid-way.
   */
  async interruptStaleImports(db: RepoDb, at: string): Promise<string[]> {
    const stale = await db.getAllAsync<{ asset_id: string; operation_id: string }>(
      `SELECT asset_id, operation_id FROM pointcloud_imports WHERE import_status = 'importing'`
    );
    for (const row of stale) {
      await db.runAsync(`BEGIN IMMEDIATE`, []);
      try {
        await db.runAsync(
          `UPDATE pointcloud_imports SET import_status = 'interrupted', updated_at = ? WHERE asset_id = ?`,
          [at, row.asset_id]
        );
        await db.runAsync(
          `UPDATE processing_operations SET status = 'failed', message = 'interrupted: app stopped mid-import', finished_at = ? WHERE operation_id = ?`,
          [at, row.operation_id]
        );
        await db.runAsync(`COMMIT`, []);
      } catch (err) {
        await db.runAsync(`ROLLBACK`, []);
        throw err;
      }
    }
    return stale.map((r) => r.asset_id);
  },

  async getImport(db: RepoDb, assetId: string): Promise<ImportRow | null> {
    return db.getFirstAsync<ImportRow>(`SELECT * FROM pointcloud_imports WHERE asset_id = ?`, [assetId]);
  },

  async listImports(db: RepoDb, projectId: string): Promise<ImportRow[]> {
    return db.getAllAsync<ImportRow>(
      `SELECT * FROM pointcloud_imports WHERE project_id = ? ORDER BY created_at DESC`,
      [projectId]
    );
  },
};
