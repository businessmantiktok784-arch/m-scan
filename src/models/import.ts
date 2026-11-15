/**
 * Stage 3.1 — external point-cloud IMPORT contracts (zod).
 *
 * Mirrors `schemas/pointcloud-import.schema.json` (validation report +
 * import lifecycle) and the `pointcloud_imports` / `processing_operations`
 * satellite tables from migration v3.
 *
 * These contracts are pure (no React Native imports).
 */
import { z } from "zod";

export const importVerdictSchema = z.enum([
  "valid",
  "valid_with_warnings",
  "invalid",
  "unsupported",
  "incomplete",
  "not_verified",
]);
export type ImportVerdict = z.infer<typeof importVerdictSchema>;

/** Lifecycle of one import row in `pointcloud_imports`. */
export const importStatusSchema = z.enum(["importing", "succeeded", "failed", "interrupted"]);
export type ImportStatus = z.infer<typeof importStatusSchema>;

export const pointCloudImportRecordSchema = z.object({
  asset_id: z.string().regex(/^PC-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  operation_id: z.string().regex(/^OP-[0-9a-f]{8}$/),
  /** Original file name as picked (sanitized before use in paths). */
  original_filename: z.string().min(1).max(255),
  /** Project-relative path of the preserved source file. */
  stored_rel_path: z.string().min(1),
  format: z.enum(["ply", "xyz", "las", "laz"]),
  byte_size: z.number().int().nonnegative(),
  checksum_md5: z.string().regex(/^[0-9a-f]{32}$/),
  validation_status: importVerdictSchema,
  import_status: importStatusSchema,
  /** Counted from decoded data where the format allows; null = not counted. */
  point_count: z.number().int().nonnegative().nullable(),
  /** Full asset.json payload (v1.3 pointcloud-asset) as written to disk. */
  meta_json: z.string(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type PointCloudImportRecord = z.infer<typeof pointCloudImportRecordSchema>;

export const importOperationRecordSchema = z.object({
  operation_id: z.string().regex(/^OP-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  operation: z.literal("pointcloud_import"),
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  input_ref: z.string().max(500),
  output_asset_id: z.string().regex(/^PC-[0-9a-f]{8}$/).nullable(),
  /** Real tool identity — never a fabricated version string. */
  tool: z.string().min(1).max(200),
  tool_version: z.string().min(1).max(60),
  message: z.string().max(2000).default(""),
  detail_json: z.string().default("{}"),
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }).nullable(),
});
export type ImportOperationRecord = z.infer<typeof importOperationRecordSchema>;

/**
 * Tool identity for import provenance. The version comes from the app
 * config (`expo-constants`); "unknown" when unavailable — never invented.
 */
export function importToolIdentity(appVersion: string | undefined): { tool: string; tool_version: string } {
  return {
    tool: "mining-scanner mobile import",
    tool_version: appVersion && appVersion.length > 0 ? appVersion : "unknown",
  };
}
