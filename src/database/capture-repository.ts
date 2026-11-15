/**
 * Capture repository — Stage 2 SQL for the capture-session lifecycle.
 *
 * Reuses the Stage 1 tables:
 *   - `scan_sessions` keeps the shared status vocabulary
 *     (planned/collecting/collected/aborted) driven by the state machine.
 *   - `assets` indexes every camera segment and sensor-stream file
 *     (kind: 'camera_video' | 'sensor_stream'; details in meta_json).
 * New satellite table `capture_sessions` (migration v2) holds the lifecycle
 * phase, timestamps, interruption count and error text.
 *
 * Single-capture rule: at most one capture row may sit in an active phase.
 * Enforced here by an explicit check inside the same transaction that
 * inserts the new row.
 */
import { openDatabase } from "./db";
import { projectRepository } from "./project-repository";
import { captureConfigSchema, captureConfigDefaults } from "../models/capture";
import type { CaptureConfig } from "../models/capture";
import { scanSessionSchema, type ScanSession } from "../models/models";
import { isActivePhase, type SessionPhase } from "../capture/session-machine";
import { captureTimestamp } from "../capture/time";
import type { TimestampPair } from "../models/capture";

const ACTIVE_PHASES = ["preparing", "ready", "capturing", "paused", "stopping"];

export interface CaptureSessionRecord {
  session_id: string;
  project_id: string;
  phase: SessionPhase;
  config: CaptureConfig;
  started_at: TimestampPair | null;
  ended_at: TimestampPair | null;
  active_duration_s: number;
  interruption_count: number;
  last_error: string;
}

interface CaptureRow {
  session_id: string;
  project_id: string;
  phase: string;
  config_json: string;
  started_epoch_ms: number | null;
  started_monotonic_ms: number | null;
  ended_epoch_ms: number | null;
  ended_monotonic_ms: number | null;
  active_duration_s: number;
  interruption_count: number;
  last_error: string;
}

function pair(row: CaptureRow, prefix: "started" | "ended"): TimestampPair | null {
  const epoch = row[`${prefix}_epoch_ms`];
  const mono = row[`${prefix}_monotonic_ms`];
  if (epoch === null || mono === null) return null;
  return { epoch_ms: epoch, monotonic_ms: mono, monotonic_source: "performance.now" };
}

export interface StoredAsset {
  asset_id: string;
  kind: string;
  file_path: string;
  byte_size: number;
  meta: Record<string, unknown>;
}

export const captureRepository = {
  /** Throws when another capture is active — prevents parallel sessions. */
  async begin(input: {
    projectId: string;
    sessionId: string;
    label: string;
    config: CaptureConfig;
  }): Promise<void> {
    const db = await openDatabase();
    const now = new Date().toISOString();
    const started = captureTimestamp();
    await db.withTransactionAsync(async () => {
      const existing = await db.getFirstAsync<{ session_id: string }>(
        `SELECT session_id FROM capture_sessions WHERE phase IN (${ACTIVE_PHASES.map(() => "?").join(",")})`,
        ACTIVE_PHASES
      );
      if (existing) {
        throw new Error(
          `Another capture session (${existing.session_id}) is active. Stop it before starting a new one.`
        );
      }
      // Parent row first: capture_sessions.session_id references scan_sessions.
      await db.runAsync(
        `INSERT INTO scan_sessions (session_id, project_id, label, status, started_at, ended_at, notes)
         VALUES (?, ?, ?, 'planned', ?, NULL, '')`,
        [input.sessionId, input.projectId, input.label, now]
      );
      await db.runAsync(
        `INSERT INTO capture_sessions
           (session_id, project_id, phase, config_json,
            started_epoch_ms, started_monotonic_ms, created_at, updated_at)
         VALUES (?, ?, 'preparing', ?, ?, ?, ?, ?)`,
        [input.sessionId, input.projectId, JSON.stringify(input.config), started.epoch_ms, started.monotonic_ms, now, now]
      );
    });
  },

  async updatePhase(sessionId: string, phase: SessionPhase, extra?: { error?: string }): Promise<void> {
    const db = await openDatabase();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE capture_sessions SET phase = ?, last_error = ?, updated_at = ? WHERE session_id = ?`, [
      phase,
      extra?.error ?? "",
      now,
      sessionId,
    ]);
    // Keep the shared Stage 1 session status in step with the machine.
    const status = phase === "capturing" || phase === "paused" || phase === "stopping" ? "collecting" : phase === "stopped" ? "collected" : phase === "aborted" ? "aborted" : phase === "failed" ? "aborted" : "planned";
    await db.runAsync(`UPDATE scan_sessions SET status = ? WHERE session_id = ?`, [status, sessionId]);
  },

  async markStarted(sessionId: string, started: TimestampPair): Promise<void> {
    const db = await openDatabase();
    await db.runAsync(
      `UPDATE capture_sessions SET started_epoch_ms = ?, started_monotonic_ms = ?, updated_at = ? WHERE session_id = ?`,
      [started.epoch_ms, started.monotonic_ms, new Date().toISOString(), sessionId]
    );
  },

  async markEnded(sessionId: string, ended: TimestampPair, activeDurationS: number): Promise<void> {
    const db = await openDatabase();
    await db.runAsync(
      `UPDATE capture_sessions SET ended_epoch_ms = ?, ended_monotonic_ms = ?, active_duration_s = ?, updated_at = ? WHERE session_id = ?`,
      [ended.epoch_ms, ended.monotonic_ms, activeDurationS, new Date().toISOString(), sessionId]
    );
  },

  async addInterruption(sessionId: string): Promise<void> {
    const db = await openDatabase();
    await db.runAsync(
      `UPDATE capture_sessions SET interruption_count = interruption_count + 1, updated_at = ? WHERE session_id = ?`,
      [new Date().toISOString(), sessionId]
    );
  },

  async get(sessionId: string): Promise<CaptureSessionRecord | null> {
    const db = await openDatabase();
    const row = await db.getFirstAsync<CaptureRow>(`SELECT * FROM capture_sessions WHERE session_id = ?`, [sessionId]);
    if (!row) return null;
    return {
      session_id: row.session_id,
      project_id: row.project_id,
      phase: row.phase as SessionPhase,
      config: captureConfigSchema.parse(JSON.parse(row.config_json)),
      started_at: pair(row, "started"),
      ended_at: pair(row, "ended"),
      active_duration_s: row.active_duration_s,
      interruption_count: row.interruption_count,
      last_error: row.last_error,
    };
  },

  /** Any capture in an active phase on this device (single-capture rule). */
  async hasActiveCapture(): Promise<boolean> {
    const db = await openDatabase();
    const row = await db.getFirstAsync<{ session_id: string }>(
      `SELECT session_id FROM capture_sessions WHERE phase IN (${ACTIVE_PHASES.map(() => "?").join(",")})`,
      ACTIVE_PHASES
    );
    return row !== null;
  },

  /** Indexes a finalized camera segment or sensor-stream file. */
  async addAsset(input: {
    assetId: string;
    projectId: string;
    sessionId: string;
    kind: "camera_video" | "sensor_stream" | "pointcloud" | "frame_set" | "camera_calibration";
    filePath: string;
    byteSize: number;
    meta: Record<string, unknown>;
  }): Promise<void> {
    const db = await openDatabase();
    await db.runAsync(
      `INSERT INTO assets (asset_id, project_id, session_id, kind, file_path, byte_size, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.assetId,
        input.projectId,
        input.sessionId,
        input.kind,
        input.filePath,
        input.byteSize,
        JSON.stringify(input.meta),
        new Date().toISOString(),
      ]
    );
  },

  async listAssets(projectId: string, sessionId?: string): Promise<StoredAsset[]> {
    const db = await openDatabase();
    const rows = await db.getAllAsync<{
      asset_id: string;
      kind: string;
      file_path: string;
      byte_size: number;
      meta_json: string;
    }>(
      sessionId
        ? `SELECT * FROM assets WHERE project_id = ? AND session_id = ? ORDER BY created_at`
        : `SELECT * FROM assets WHERE project_id = ? ORDER BY created_at`,
      sessionId ? [projectId, sessionId] : [projectId]
    );
    return rows.map((r) => ({
      asset_id: r.asset_id,
      kind: r.kind,
      file_path: r.file_path,
      byte_size: r.byte_size,
      meta: safeParse(r.meta_json),
    }));
  },

  async listSessions(projectId: string): Promise<ScanSession[]> {
    return projectRepository.listSessions(projectId);
  },

  /** Per-project capture summary for the Projects dashboard. */
  async projectSummaries(): Promise<Map<string, { sessions: number; latestStatus: string | null; captureBytes: number }>> {
    const db = await openDatabase();
    const counts = await db.getAllAsync<{
      project_id: string;
      sessions: number;
      latest_status: string | null;
    }>(
      `SELECT p.project_id,
              COUNT(s.session_id) AS sessions,
              (SELECT status FROM scan_sessions WHERE project_id = p.project_id ORDER BY started_at DESC LIMIT 1) AS latest_status
       FROM projects p
       LEFT JOIN scan_sessions s ON s.project_id = p.project_id
       GROUP BY p.project_id`
    );
    const bytes = await db.getAllAsync<{ project_id: string; bytes: number }>(
      `SELECT project_id, COALESCE(SUM(byte_size), 0) AS bytes FROM assets GROUP BY project_id`
    );
    const byBytes = new Map(bytes.map((b) => [b.project_id, b.bytes]));
    return new Map(
      counts.map((c) => [
        c.project_id,
        { sessions: c.sessions, latestStatus: c.latest_status, captureBytes: byBytes.get(c.project_id) ?? 0 },
      ])
    );
  },
};

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Re-exported so the recorder can create defaults without knowing zod.
export { captureConfigDefaults };
