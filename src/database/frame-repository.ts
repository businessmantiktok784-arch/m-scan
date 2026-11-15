/**
 * Frame-extraction repository — Stage 3.2 SQL for the extraction lifecycle.
 *
 * Reuses the v3 `processing_operations` table for provenance rows (the same
 * one `pointcloud_import` writes to — no duplicate operation table) and adds
 * two v4 satellite tables: `frame_extractions` (the job) and `frames` (one
 * row per extracted image). The `assets` row for the frame set is inserted
 * in the SAME transaction that flips `extraction_status` to 'done' — a
 * failed, cancelled or interrupted extraction never registers as an asset.
 *
 * Depends on the same structural `RepoDb` as the import repository, so the
 * whole lifecycle is testable off-device with bun:sqlite.
 */
import type { RepoDb } from "./import-repository";
import type { ExtractionJob, FrameRecord } from "../frame/models";

export const frameRepository = {
  /** Opens the job: processing_operations row ('running') + job row ('running'). */
  async beginExtraction(db: RepoDb, job: ExtractionJob): Promise<void> {
    await db.runAsync(`BEGIN IMMEDIATE`, []);
    try {
      await db.runAsync(
        `INSERT INTO processing_operations
           (operation_id, project_id, operation, status, input_ref, tool, tool_version, message, detail_json, started_at)
         VALUES (?, ?, 'frame_extraction', 'running', ?, ?, ?, '', ?, ?)`,
        [
          job.job_id,
          job.project_id,
          job.sources.map((s) => s.asset_id).join(","),
          job.decoder.tool,
          job.decoder.tool_version,
          JSON.stringify({ settings: job.settings, decoder: job.decoder }),
          job.started_at,
        ],
      );
      await db.runAsync(
        `INSERT INTO frame_extractions
           (job_id, project_id, session_id, extraction_status, settings_json, decoder_json,
            output_dir, sources_json, frames_failed, warnings_json, errors_json, meta_json, started_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, 0, '[]', '[]', ?, ?, ?)`,
        [
          job.job_id,
          job.project_id,
          job.session_id,
          JSON.stringify(job.settings),
          JSON.stringify(job.decoder),
          job.output_directory,
          JSON.stringify(job.sources),
          JSON.stringify(job), // full job record, readable via getExtraction even if the app dies mid-run
          job.started_at,
          job.started_at,
        ],
      );
      await db.runAsync(`COMMIT`, []);
    } catch (err) {
      await db.runAsync(`ROLLBACK`, []).catch(() => undefined);
      throw err;
    }
  },

  /** Appends one verified frame row (idempotent per (job, index)). */
  async addFrame(db: RepoDb, frame: FrameRecord): Promise<void> {
    await db.runAsync(
      `INSERT OR REPLACE INTO frames
         (frame_id, job_id, project_id, session_id, source_video_asset_id, source_video_segment_index,
          frame_index, file_path, image_format, width, height, sample_time_s, pts_ms, time_base,
          capture_time_mapping, byte_size, checksum_md5, extraction_method, validation_status,
          warnings_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        frame.frame_id,
        frame.job_id,
        frame.project_id,
        frame.session_id,
        frame.source_video_asset_id,
        frame.source_video_segment_index,
        frame.frame_index,
        frame.file_path,
        frame.image_format,
        frame.width,
        frame.height,
        frame.sample_time_s,
        frame.pts_ms,
        frame.time_base,
        frame.capture_time_mapping,
        frame.byte_size,
        frame.checksum_md5,
        frame.extraction_method,
        frame.validation_status,
        JSON.stringify(frame.warnings),
        frame.created_at,
      ],
    );
  },

  /** Failure/cancel path: flips the job + operation rows, records the reason. */
  async markFailed(
    db: RepoDb,
    input: { jobId: string; status: "failed" | "cancelled"; message: string; warnings: string[]; errors: string[]; finishedAt: string },
  ): Promise<void> {
    const opStatus = input.status === "cancelled" ? "cancelled" : "failed";
    await db.runAsync(
      `UPDATE frame_extractions
         SET extraction_status = ?, errors_json = ?, warnings_json = ?, meta_json =
             json_set(COALESCE(meta_json, '{}'), '$.message', ?),
             finished_at = ?, updated_at = ?
       WHERE job_id = ?`,
      [input.status, JSON.stringify(input.errors), JSON.stringify(input.warnings), input.message, input.finishedAt, input.finishedAt, input.jobId],
    );
    await db.runAsync(
      `UPDATE processing_operations
         SET status = ?, message = ?, finished_at = ?
       WHERE operation_id = ?`,
      [opStatus, input.message, input.finishedAt, input.jobId],
    );
  },

  /**
   * Success path, in ONE transaction: the assets row for the frame set and
   * the 'done' flips. Until this commits, nothing about the extraction is
   * registered as an asset.
   */
  async markSucceeded(
    db: RepoDb,
    input: { job: ExtractionJob; framesExtracted: number; warnings: string[]; finishedAt: string },
  ): Promise<void> {
    const { job } = input;
    await db.runAsync(`BEGIN IMMEDIATE`, []);
    try {
      await db.runAsync(
        `INSERT INTO assets (asset_id, project_id, session_id, kind, file_path, byte_size, meta_json, created_at)
         VALUES (?, ?, ?, 'frame_set', ?, ?, ?, ?)`,
        [
          job.job_id,
          job.project_id,
          job.session_id,
          job.output_directory,
          0, // directory; per-frame sizes live in `frames`
          JSON.stringify(job),
          input.finishedAt,
        ],
      );
      await db.runAsync(
        `UPDATE frame_extractions
           SET extraction_status = 'done', frames_extracted = ?, warnings_json = ?, finished_at = ?, updated_at = ?
         WHERE job_id = ?`,
        [input.framesExtracted, JSON.stringify(input.warnings), input.finishedAt, input.finishedAt, job.job_id],
      );
      await db.runAsync(
        `UPDATE processing_operations
           SET status = 'succeeded', output_asset_id = ?, message = ?, finished_at = ?
         WHERE operation_id = ?`,
        [job.job_id, `${input.framesExtracted} frames extracted`, input.finishedAt, job.job_id],
      );
      await db.runAsync(`COMMIT`, []);
    } catch (err) {
      await db.runAsync(`ROLLBACK`, []).catch(() => undefined);
      throw err;
    }
  },

  /** Crash reconciliation: stale 'running' jobs become 'interrupted'. */
  async interruptStaleExtractions(db: RepoDb, nowIso: string): Promise<string[]> {
    const rows = await db.getAllAsync<{ job_id: string }>(
      `SELECT job_id FROM frame_extractions WHERE extraction_status IN ('queued','running')`,
    );
    for (const row of rows) {
      await db.runAsync(
        `UPDATE frame_extractions SET extraction_status = 'interrupted', finished_at = ?, updated_at = ? WHERE job_id = ?`,
        [nowIso, nowIso, row.job_id],
      );
      await db.runAsync(
        `UPDATE processing_operations SET status = 'failed', message = 'interrupted (app stopped mid-extraction)', finished_at = ?
         WHERE operation_id = ? AND status = 'running'`,
        [nowIso, row.job_id],
      );
    }
    return rows.map((r) => r.job_id);
  },

  async getExtraction(db: RepoDb, jobId: string): Promise<ExtractionJob | null> {
    const row = await db.getFirstAsync<{ meta_json: string }>(
      `SELECT meta_json FROM frame_extractions WHERE job_id = ?`,
      [jobId],
    );
    if (!row) return null;
    try {
      return JSON.parse(row.meta_json) as ExtractionJob;
    } catch {
      return null;
    }
  },

  async listExtractions(db: RepoDb, projectId: string): Promise<ExtractionJob[]> {
    const rows = await db.getAllAsync<{ meta_json: string }>(
      `SELECT meta_json FROM frame_extractions WHERE project_id = ? ORDER BY started_at DESC`,
      [projectId],
    );
    return rows
      .map((r) => {
        try {
          return JSON.parse(r.meta_json) as ExtractionJob;
        } catch {
          return null;
        }
      })
      .filter((j): j is ExtractionJob => j !== null);
  },

  async listFrames(db: RepoDb, jobId: string): Promise<FrameRecord[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM frames WHERE job_id = ? ORDER BY source_video_segment_index, frame_index`,
      [jobId],
    );
    return rows.map(rowToFrame);
  },

  async countFrames(db: RepoDb, jobId: string): Promise<{ extracted: number; failed: number }> {
    const row = await db.getFirstAsync<{ extracted: number; failed: number }>(
      `SELECT
         SUM(CASE WHEN validation_status = 'pass' THEN 1 ELSE 0 END) AS extracted,
         SUM(CASE WHEN validation_status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM frames WHERE job_id = ?`,
      [jobId],
    );
    return { extracted: row?.extracted ?? 0, failed: row?.failed ?? 0 };
  },
};

function rowToFrame(row: Record<string, unknown>): FrameRecord {
  return {
    frame_id: String(row.frame_id),
    job_id: String(row.job_id),
    project_id: String(row.project_id),
    session_id: String(row.session_id),
    source_video_asset_id: String(row.source_video_asset_id),
    source_video_segment_index: (row.source_video_segment_index as number | null) ?? null,
    frame_index: Number(row.frame_index),
    file_path: String(row.file_path),
    image_format: row.image_format === "jpeg" ? "jpeg" : "png",
    width: (row.width as number | null) ?? null,
    height: (row.height as number | null) ?? null,
    sample_time_s: Number(row.sample_time_s),
    pts_ms: (row.pts_ms as number | null) ?? null,
    time_base: (row.time_base as string | null) ?? null,
    capture_time_mapping: row.capture_time_mapping === "other_documented" ? "other_documented" : "unavailable",
    capture_time_detail: "",
    byte_size: Number(row.byte_size),
    checksum_md5: String(row.checksum_md5),
    extraction_method: row.extraction_method === "pts_decode" ? "pts_decode" : "seek_decode",
    validation_status: row.validation_status === "pass" ? "pass" : row.validation_status === "failed" ? "failed" : "unverified",
    warnings: safeArray(row.warnings_json),
    created_at: String(row.created_at),
  };
}

function safeArray(json: unknown): string[] {
  try {
    const v = JSON.parse(String(json));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
