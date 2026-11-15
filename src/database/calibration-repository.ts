/**
 * Camera-calibration repository — Stage 3.3 SQL for the calibration lifecycle.
 *
 * Same pattern as the Stage 3.1/3.2 repositories: the run is opened with a
 * `processing_operations` row ('running') + a `camera_calibrations` row
 * ('running', full draft in meta_json for crash reconciliation). Success
 * writes the `assets` row (kind `camera_calibration`) in the SAME
 * transaction that flips the status — a failed, cancelled or interrupted
 * run never registers as an asset. Image bytes stay on disk, never in
 * SQLite.
 */
import type { RepoDb } from "./import-repository";
import type { CalibrationRecord, CalibrationRunSettings, CheckerboardTarget } from "../calibration/models";

export const calibrationRepository = {
  /** Opens the run: processing_operations row ('running') + run row ('running'). */
  async beginCalibration(
    db: RepoDb,
    input: {
      calibrationId: string;
      projectId: string;
      sessionId: string | null;
      cameraLabel: string;
      outputDir: string;
      settings: CalibrationRunSettings;
      target: CheckerboardTarget;
      frameCount: number;
      startedAt: string;
    },
  ): Promise<void> {
    await db.runAsync(`BEGIN IMMEDIATE`, []);
    try {
      await db.runAsync(
        `INSERT INTO processing_operations
           (operation_id, project_id, operation, status, input_ref, tool, tool_version, message, detail_json, started_at)
         VALUES (?, ?, 'camera_calibration', 'running', ?, 'mining-scanner calibration core (pure TypeScript Zhang)', ?, '', ?, ?)`,
        [
          input.calibrationId,
          input.projectId,
          `${input.frameCount} frame(s), ${input.target.corner_rows}x${input.target.corner_columns} target`,
          "", // tool_version is filled from the real app version at success time
          JSON.stringify({ settings: input.settings, target: input.target }),
          input.startedAt,
        ],
      );
      await db.runAsync(
        `INSERT INTO camera_calibrations
           (calibration_id, project_id, session_id, operation_id, camera_label, calibration_status,
            source, calibration_method, output_dir, settings_json, frame_count, meta_json, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', '', 'known_target_checkerboard', ?, ?, ?, ?, ?, ?)`,
        [
          input.calibrationId,
          input.projectId,
          input.sessionId,
          input.calibrationId, // operation_id = calibration_id (one operation per run)
          input.cameraLabel,
          input.outputDir,
          JSON.stringify(input.settings),
          input.frameCount,
          JSON.stringify({ settings: input.settings, target: input.target }),
          input.startedAt,
          input.startedAt,
        ],
      );
      await db.runAsync(`COMMIT`, []);
    } catch (err) {
      await db.runAsync(`ROLLBACK`, []).catch(() => undefined);
      throw err;
    }
  },

  /** Failure/cancel path: flips the run + operation rows, records the reason. */
  async markFailed(
    db: RepoDb,
    input: { calibrationId: string; status: "failed" | "cancelled"; message: string; warnings: string[]; errors: string[]; finishedAt: string },
  ): Promise<void> {
    const opStatus = input.status === "cancelled" ? "cancelled" : "failed";
    await db.runAsync(
      `UPDATE camera_calibrations
         SET calibration_status = ?, meta_json =
             json_set(COALESCE(meta_json, '{}'), '$.message', ?, '$.warnings', ?, '$.errors', ?),
             finished_at = ?, updated_at = ?
       WHERE calibration_id = ?`,
      [
        input.status,
        input.message,
        JSON.stringify(input.warnings),
        JSON.stringify(input.errors),
        input.finishedAt,
        input.finishedAt,
        input.calibrationId,
      ],
    );
    await db.runAsync(
      `UPDATE processing_operations
         SET status = ?, message = ?, finished_at = ?
       WHERE operation_id = ?`,
      [opStatus, input.message, input.finishedAt, input.calibrationId],
    );
  },

  /**
   * Success path, in ONE transaction: the assets row for the CAL- record and
   * the 'done' flips. Until this commits, nothing about the run is
   * registered as an asset.
   */
  async markSucceeded(
    db: RepoDb,
    input: { record: CalibrationRecord; workingDirBytes: number; finishedAt: string },
  ): Promise<void> {
    const { record } = input;
    await db.runAsync(`BEGIN IMMEDIATE`, []);
    try {
      await db.runAsync(
        `INSERT INTO assets (asset_id, project_id, session_id, kind, file_path, byte_size, meta_json, created_at)
         VALUES (?, ?, ?, 'camera_calibration', ?, ?, ?, ?)`,
        [
          record.calibration_id,
          record.project_id,
          record.session_id,
          `${record.calibration_id}/metadata/calibration.json`,
          input.workingDirBytes,
          JSON.stringify(record),
          input.finishedAt,
        ],
      );
      // Merge the finished record into the run row's meta_json (which carries
      // the begin-time draft for crash reconciliation). The RUN status becomes
      // 'done' — the record's own calibration_status (computed / with
      // warnings) is a different, per-record concept.
      const runRow = await db.getFirstAsync<{ meta_json: string | null }>(
        `SELECT meta_json FROM camera_calibrations WHERE calibration_id = ?`,
        [record.calibration_id],
      );
      let meta: Record<string, unknown> = {};
      if (runRow?.meta_json) {
        try {
          meta = JSON.parse(runRow.meta_json) as Record<string, unknown>;
        } catch {
          meta = {};
        }
      }
      meta.record = record;
      await db.runAsync(
        `UPDATE camera_calibrations
           SET calibration_status = 'done', source = ?, calibration_method = ?, image_width = ?, image_height = ?,
               reprojection_error_px = ?, frames_accepted = ?, frames_rejected = ?, meta_json = ?, finished_at = ?, updated_at = ?
         WHERE calibration_id = ?`,
        [
          record.source,
          record.calibration_method,
          record.image_width,
          record.image_height,
          record.metrics.reprojection_error_px,
          record.metrics.frames_accepted,
          record.metrics.frames_rejected,
          JSON.stringify(meta),
          input.finishedAt,
          input.finishedAt,
          record.calibration_id,
        ],
      );
      await db.runAsync(
        `UPDATE processing_operations
           SET status = 'succeeded', output_asset_id = ?, tool_version = ?, message = ?, finished_at = ?
         WHERE operation_id = ?`,
        [
          record.calibration_id,
          record.engine.tool_version,
          `calibration ${record.calibration_status} (RMS ${record.metrics.reprojection_error_px === null ? "n/a" : `${record.metrics.reprojection_error_px.toFixed(3)} px`})`,
          input.finishedAt,
          record.calibration_id,
        ],
      );
      await db.runAsync(`COMMIT`, []);
    } catch (err) {
      await db.runAsync(`ROLLBACK`, []).catch(() => undefined);
      throw err;
    }
  },

  /** Crash reconciliation: stale 'running' runs become 'interrupted'. */
  async interruptStaleCalibrations(db: RepoDb, nowIso: string): Promise<string[]> {
    const rows = await db.getAllAsync<{ calibration_id: string }>(
      `SELECT calibration_id FROM camera_calibrations WHERE calibration_status IN ('queued','running')`,
    );
    for (const row of rows) {
      await db.runAsync(
        `UPDATE camera_calibrations SET calibration_status = 'interrupted', finished_at = ?, updated_at = ? WHERE calibration_id = ?`,
        [nowIso, nowIso, row.calibration_id],
      );
      await db.runAsync(
        `UPDATE processing_operations SET status = 'failed', message = 'interrupted (app stopped mid-calibration)', finished_at = ?
         WHERE operation_id = ? AND status = 'running'`,
        [nowIso, row.calibration_id],
      );
    }
    return rows.map((r) => r.calibration_id);
  },

  async getCalibration(db: RepoDb, calibrationId: string): Promise<CalibrationRecord | null> {
    const row = await db.getFirstAsync<{ meta_json: string }>(
      `SELECT meta_json FROM camera_calibrations WHERE calibration_id = ?`,
      [calibrationId],
    );
    if (!row) return null;
    try {
      const meta = JSON.parse(row.meta_json) as { record?: CalibrationRecord };
      return meta.record ?? null;
    } catch {
      return null;
    }
  },

  async listCalibrations(db: RepoDb, projectId: string): Promise<CalibrationRecord[]> {
    const rows = await db.getAllAsync<{ meta_json: string }>(
      `SELECT meta_json FROM camera_calibrations WHERE project_id = ? ORDER BY started_at DESC`,
      [projectId],
    );
    return rows
      .map((r) => {
        try {
          const meta = JSON.parse(r.meta_json) as { record?: CalibrationRecord };
          return meta.record ?? null;
        } catch {
          return null;
        }
      })
      .filter((r): r is CalibrationRecord => r !== null);
  },
};
