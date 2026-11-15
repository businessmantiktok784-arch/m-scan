/**
 * Versioned, append-only database migrations — pure data + pure runner.
 *
 * Deliberately free of React Native / expo imports so the migration SQL and
 * the bookkeeping logic can be verified off-device (bun:sqlite). Each
 * migration runs at most once; success is recorded in `_migrations`, so an
 * interrupted upgrade resumes cleanly on the next start.
 *
 * v1 — Stage 1 foundation: projects, scan sessions, asset index.
 * v3 — Stage 3.1: processing-operation provenance + point-cloud import
 *       lifecycle (satellite tables only; no existing table is altered).
 * v4 — Stage 3.2: frame-extraction lifecycle (frame_extractions, frames).
 * v5 — Stage 3.3: camera-calibration lifecycle (camera_calibrations).
 */

export interface MigrationAdapter {
  /** Executes one or more statements (may be async). */
  exec(sql: string): void | Promise<void>;
  /** Runs a parameterised statement (may be async). */
  run(sql: string, params: unknown[]): void | Promise<void>;
  /** Returns the first row of a query, or null (may be async). */
  getOne(sql: string):
    | { max: number | null }
    | null
    | Promise<{ max: number | null } | null>;
}

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
      project_id    TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      site_name     TEXT NOT NULL DEFAULT '',
      notes         TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS scan_sessions (
      session_id    TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(project_id),
      label         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'planned',
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      notes         TEXT NOT NULL DEFAULT ''
   );`,
  `CREATE TABLE IF NOT EXISTS assets (
      asset_id      TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(project_id),
      session_id    TEXT,
      kind          TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      byte_size     INTEGER NOT NULL DEFAULT 0,
      meta_json     TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project ON scan_sessions(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);`,
  // v2 — Stage 2: real capture sessions (lifecycle state-machine records).
  // Stage 1 tables and rows are untouched; this only adds a satellite table.
  `CREATE TABLE IF NOT EXISTS capture_sessions (
      session_id       TEXT PRIMARY KEY REFERENCES scan_sessions(session_id),
      project_id       TEXT NOT NULL REFERENCES projects(project_id),
      phase            TEXT NOT NULL,
      config_json      TEXT NOT NULL DEFAULT '{}',
      started_epoch_ms INTEGER,
      started_monotonic_ms REAL,
      ended_epoch_ms   INTEGER,
      ended_monotonic_ms REAL,
      active_duration_s REAL NOT NULL DEFAULT 0,
      interruption_count INTEGER NOT NULL DEFAULT 0,
      last_error       TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_capture_sessions_project ON capture_sessions(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_capture_sessions_phase ON capture_sessions(phase);`,
  // v3 — Stage 3.1: generic processing-operation provenance. One row per
  // long-running operation (currently only `pointcloud_import`); the app
  // writes tool identity from its real app version, never a fake.
  `CREATE TABLE IF NOT EXISTS processing_operations (
      operation_id    TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(project_id),
      operation       TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'queued',
      input_ref       TEXT NOT NULL DEFAULT '',
      output_asset_id TEXT,
      tool            TEXT NOT NULL DEFAULT '',
      tool_version    TEXT NOT NULL DEFAULT '',
      message         TEXT NOT NULL DEFAULT '',
      detail_json     TEXT NOT NULL DEFAULT '{}',
      started_at      TEXT NOT NULL,
      finished_at     TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS idx_processing_operations_project ON processing_operations(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_processing_operations_status ON processing_operations(status);`,
  // v3 — Stage 3.1: import lifecycle. `meta_json` mirrors the asset.json
  // sidecar (v1.3 pointcloud-asset); file BYTES stay on disk, never here.
  // NOTE: asset_id deliberately has NO foreign key to `assets` — a row exists
  // while the import is still running so a crash can be reconciled, and a
  // FAILED import must never register as an asset. The assets row is written
  // in the same transaction that flips import_status to 'succeeded'.
  `CREATE TABLE IF NOT EXISTS pointcloud_imports (
      asset_id          TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(project_id),
      operation_id      TEXT NOT NULL REFERENCES processing_operations(operation_id),
      original_filename TEXT NOT NULL,
      stored_rel_path   TEXT NOT NULL,
      format            TEXT NOT NULL,
      byte_size         INTEGER NOT NULL,
      checksum_md5      TEXT NOT NULL,
      validation_status TEXT NOT NULL,
      import_status     TEXT NOT NULL DEFAULT 'importing',
      point_count       INTEGER,
      meta_json         TEXT NOT NULL DEFAULT '{}',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_pointcloud_imports_project ON pointcloud_imports(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_pointcloud_imports_status ON pointcloud_imports(import_status);`,
  // v4 — Stage 3.2: frame-extraction lifecycle. Same pattern as v3: a job
  // row exists while the extraction runs so a crash can be reconciled; the
  // `assets` row for the frame set is written in the SAME transaction that
  // flips `extraction_status` to 'done'. A failed or interrupted extraction
  // therefore never registers as an asset. Image BYTES stay on disk.
  `CREATE TABLE IF NOT EXISTS frame_extractions (
      job_id            TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(project_id),
      session_id        TEXT REFERENCES scan_sessions(session_id),
      extraction_status TEXT NOT NULL DEFAULT 'queued',
      settings_json     TEXT NOT NULL DEFAULT '{}',
      decoder_json      TEXT NOT NULL DEFAULT '{}',
      output_dir        TEXT NOT NULL DEFAULT '',
      sources_json      TEXT NOT NULL DEFAULT '[]',
      frames_extracted  INTEGER,
      frames_failed     INTEGER NOT NULL DEFAULT 0,
      warnings_json     TEXT NOT NULL DEFAULT '[]',
      errors_json       TEXT NOT NULL DEFAULT '[]',
      meta_json         TEXT NOT NULL DEFAULT '{}',
      started_at        TEXT NOT NULL,
      finished_at       TEXT,
      updated_at        TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_frame_extractions_project ON frame_extractions(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_frame_extractions_status ON frame_extractions(extraction_status);`,
  // One row per extracted image; the image file itself is never in SQLite.
  `CREATE TABLE IF NOT EXISTS frames (
      frame_id            TEXT PRIMARY KEY,
      job_id              TEXT NOT NULL REFERENCES frame_extractions(job_id),
      project_id          TEXT NOT NULL REFERENCES projects(project_id),
      session_id          TEXT REFERENCES scan_sessions(session_id),
      source_video_asset_id TEXT NOT NULL,
      source_video_segment_index INTEGER,
      frame_index         INTEGER NOT NULL,
      file_path           TEXT NOT NULL,
      image_format        TEXT NOT NULL,
      width               INTEGER,
      height              INTEGER,
      sample_time_s       REAL NOT NULL,
      pts_ms              INTEGER,
      time_base           TEXT,
      capture_time_mapping TEXT NOT NULL DEFAULT 'unavailable',
      byte_size           INTEGER NOT NULL,
      checksum_md5        TEXT NOT NULL,
      extraction_method   TEXT NOT NULL,
      validation_status   TEXT NOT NULL DEFAULT 'unverified',
      warnings_json       TEXT NOT NULL DEFAULT '[]',
      created_at          TEXT NOT NULL,
      UNIQUE (job_id, source_video_asset_id, frame_index)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_frames_job ON frames(job_id);`,
  `CREATE INDEX IF NOT EXISTS idx_frames_project ON frames(project_id);`,
  // v5 — Stage 3.3: calibration lifecycle. Same pattern as v3/v4: a run row
  // exists while the calibration runs so a crash can be reconciled; the
  // `assets` row (kind 'camera_calibration') is written in the SAME
  // transaction that flips calibration_status to its terminal value. A
  // failed or interrupted run never registers as an asset.
  `CREATE TABLE IF NOT EXISTS camera_calibrations (
      calibration_id      TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL REFERENCES projects(project_id),
      session_id          TEXT REFERENCES scan_sessions(session_id),
      operation_id        TEXT NOT NULL REFERENCES processing_operations(operation_id),
      camera_label        TEXT NOT NULL,
      calibration_status  TEXT NOT NULL DEFAULT 'queued',
      source              TEXT NOT NULL DEFAULT '',
      calibration_method  TEXT NOT NULL DEFAULT '',
      image_width         INTEGER,
      image_height        INTEGER,
      reprojection_error_px REAL,
      frames_accepted     INTEGER,
      frames_rejected     INTEGER,
      output_dir          TEXT NOT NULL DEFAULT '',
      settings_json       TEXT NOT NULL DEFAULT '{}',
      frame_count         INTEGER NOT NULL DEFAULT 0,
      meta_json           TEXT NOT NULL DEFAULT '{}',
      started_at          TEXT NOT NULL,
      finished_at         TEXT,
      updated_at          TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_camera_calibrations_project ON camera_calibrations(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_camera_calibrations_status ON camera_calibrations(calibration_status);`,
];

/**
 * Applies every pending migration inside a transaction, recording each
 * applied version in `_migrations`. Safe to call repeatedly.
 */
export async function applyPendingMigrations(adapter: MigrationAdapter): Promise<number> {
  await adapter.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
        version    INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
     );`
  );
  const applied = await adapter.getOne(`SELECT MAX(version) AS max FROM _migrations`);
  const current = applied?.max ?? 0;
  let count = 0;
  for (let version = current; version < MIGRATIONS.length; version++) {
    // One transaction per migration: an interrupted upgrade leaves either the
    // old version or the new one, never a half-applied schema.
    await adapter.exec(`BEGIN`);
    try {
      await adapter.exec(MIGRATIONS[version]);
      await adapter.run(`INSERT INTO _migrations (version, applied_at) VALUES (?, ?)`, [
        version + 1,
        new Date().toISOString(),
      ]);
      await adapter.exec(`COMMIT`);
    } catch (err) {
      await adapter.exec(`ROLLBACK`);
      throw err;
    }
    count++;
  }
  return count;
}
