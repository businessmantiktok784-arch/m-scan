/**
 * Scanning-engine and data interfaces — the seams later stages plug into.
 *
 * Stage 2.1 audit note: Stage 2 delivered real capture (expo-camera video +
 * expo-sensors streams, see src/capture/). What is still missing is the
 * *processing* engine — nothing here produces a point cloud, mesh or
 * measurement. The unavailable stubs below say so explicitly, and
 * `src/engine/reconstruction.ts` defines the Stage 3 processing seams with
 * the same honest pattern.
 *
 * Removed in the Stage 2.1 audit: `ScanAssetStore` / `unavailableAssetStore`.
 * They were Stage 1 placeholders that no Stage 2 code referenced (real file
 * storage lives in `src/storage/session-store.ts`) and their "(Stage 2)"
 * message had become misleading.
 */

/** The future real-time scanning engine (tracking, depth, sensor fusion). */
export interface ScannerEngine {
  readonly name: string;
  /** Human-readable readiness statement shown on the Live Scan screen. */
  readonly status: string;
  isAvailable(): Promise<boolean>;
}

export const unavailableScannerEngine: ScannerEngine = {
  name: "unavailable-scanner-engine",
  status:
    "Capture works: camera video and motion sensor streams are recorded (Stage 2). " +
    "No scan, point cloud or mesh is produced — the processing engine arrives in Stage 3.",
  isAvailable: async () => false,
};

/** Future export pipeline. Only the planned formats are registered. */
export interface ExportFormat {
  id: string;
  label: string;
  kind: "pointcloud" | "mesh";
  /** Honest by construction: no writer is implemented yet. */
  implemented: boolean;
  notes: string;
}

export const PLANNED_EXPORT_FORMATS: ExportFormat[] = [
  { id: "ply", label: "PLY", kind: "pointcloud", implemented: false, notes: "Planned — first exchange target for point clouds." },
  { id: "xyz", label: "XYZ", kind: "pointcloud", implemented: false, notes: "Planned — plain-text point list." },
  { id: "las", label: "LAS", kind: "pointcloud", implemented: false, notes: "Planned — lidar industry standard." },
  { id: "laz", label: "LAZ", kind: "pointcloud", implemented: false, notes: "Planned — compressed LAS." },
  { id: "e57", label: "E57", kind: "pointcloud", implemented: false, notes: "Planned — with rich scan metadata." },
  { id: "obj", label: "OBJ", kind: "mesh", implemented: false, notes: "Planned — tunnel mesh exchange." },
  { id: "stl", label: "STL", kind: "mesh", implemented: false, notes: "Planned — solid modelling handoff." },
  { id: "fbx", label: "FBX", kind: "mesh", implemented: false, notes: "Planned — visualisation handoff." },
];
