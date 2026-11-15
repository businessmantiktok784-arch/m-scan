/**
 * Project repository — all SQL for scan projects lives here. Screens never
 * touch SQL directly, so the schema can evolve in one place.
 *
 * Every write goes through the shared data model validators in
 * `src/models/models.ts`, so a bad record fails loudly instead of corrupting
 * the offline database.
 */
import crypto from "expo-crypto";

import { openDatabase, type Database } from "./db";
import { projectMetadataSchema, scanSessionSchema, shortId, type ProjectMetadata, type ScanSession } from "../models/models";

function nowIso(): string {
  return new Date().toISOString();
}

async function newId(prefix: string): Promise<string> {
  return shortId(prefix, crypto.randomUUID().replace(/-/g, ""));
}

export interface NewProjectInput {
  name: string;
  site_name?: string;
  notes?: string;
}

export const projectRepository = {
  async create(input: NewProjectInput): Promise<ProjectMetadata> {
    const db = await openDatabase();
    const now = nowIso();
    const record: ProjectMetadata = {
      project_id: await newId("MS"),
      schema_version: 1,
      name: input.name.trim(),
      site_name: (input.site_name ?? "").trim(),
      notes: (input.notes ?? "").trim(),
      status: "active",
      created_at: now,
      updated_at: now,
    };
    projectMetadataSchema.parse(record); // fail loudly before the write
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT INTO projects (project_id, name, site_name, notes, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [record.project_id, record.name, record.site_name, record.notes, record.status, record.created_at, record.updated_at]
      );
      await db.runAsync(
        `INSERT INTO scan_sessions (session_id, project_id, label, status, started_at, ended_at, notes)
         VALUES (?, ?, ?, 'planned', ?, NULL, '')`,
        [await newId("SES"), record.project_id, "Initial session", record.created_at]
      );
    });
    return record;
  },

  async list(): Promise<ProjectMetadata[]> {
    const db = await openDatabase();
    const rows = await db.getAllAsync<ProjectMetadataRow>(`SELECT * FROM projects ORDER BY updated_at DESC`);
    return rows.map(rowToProject);
  },

  async get(projectId: string): Promise<ProjectMetadata | null> {
    const db = await openDatabase();
    const row = await db.getFirstAsync<ProjectMetadataRow>(
      `SELECT * FROM projects WHERE project_id = ?`,
      [projectId]
    );
    return row ? rowToProject(row) : null;
  },

  async touch(projectId: string): Promise<void> {
    const db = await openDatabase();
    await db.runAsync(`UPDATE projects SET updated_at = ? WHERE project_id = ?`, [
      nowIso(),
      projectId,
    ]);
  },

  async setStatus(projectId: string, status: "active" | "archived"): Promise<void> {
    const db = await openDatabase();
    await db.runAsync(`UPDATE projects SET status = ?, updated_at = ? WHERE project_id = ?`, [
      status,
      nowIso(),
      projectId,
    ]);
  },

  async listSessions(projectId: string): Promise<ScanSession[]> {
    const db = await openDatabase();
    const rows = await db.getAllAsync<ScanSession>(
      `SELECT * FROM scan_sessions WHERE project_id = ? ORDER BY started_at DESC`,
      [projectId]
    );
    // Same integrity rule as projects: every row read back is validated;
    // a malformed session fails loudly instead of rendering garbage.
    return rows.map((row) => scanSessionSchema.parse(row));
  },

  /** Storage summary for a project: asset count and total indexed bytes. */
  async storageSummary(projectId: string): Promise<{ assets: number; bytes: number }> {
    const db = await openDatabase();
    const row = await db.getFirstAsync<{ assets: number; bytes: number }>(
      `SELECT COUNT(*) AS assets, COALESCE(SUM(byte_size), 0) AS bytes FROM assets WHERE project_id = ?`,
      [projectId]
    );
    return { assets: row?.assets ?? 0, bytes: row?.bytes ?? 0 };
  },

  /** For tests: a direct handle after migrations. */
  async database(): Promise<Database> {
    return openDatabase();
  },
};

interface ProjectMetadataRow {
  project_id: string;
  name: string;
  site_name: string;
  notes: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectMetadataRow): ProjectMetadata {
  // Validate as-is: a corrupt row (e.g. an unknown status written by a
  // broken tool) must fail loudly, never be silently repaired to "active".
  return projectMetadataSchema.parse({
    ...row,
    schema_version: 1,
  });
}
