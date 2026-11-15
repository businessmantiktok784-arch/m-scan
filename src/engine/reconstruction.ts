/**
 * Stage 3 reconstruction seams — interfaces only, with one explicit
 * unavailable implementation.
 *
 * Stage 3 planning correction: one seam per registry operation. Visual
 * tracking, trajectory generation, point-cloud reconstruction, registration
 * and fusion are SEPARATE concerns — camera poses are not point clouds, and
 * registration only ever consumes genuine point-cloud inputs.
 *
 * The single provided implementation, `unavailableReconstructionEngine`,
 * rejects on every call: no code path can accidentally "succeed" at
 * reconstruction or emit placeholder geometry.
 *
 * Data contracts live in `src/models/reconstruction.ts` (pure zod, mirrored
 * by the JSON Schemas in `schemas/`).
 */

import { assertOperationImplemented } from "./operations";

export interface FrameExtractor {
  extractFrames(videoAssetPath: string, outputDirectory: string): Promise<unknown>;
}

/**
 * Stage 3.3 note: camera calibration left this seam — it is implemented in
 * the app (`src/calibration/calibration-core.ts`, pure-TS Zhang) and no
 * longer has an "unavailable" placeholder.
 */

/** Feature tracking only — never emits geometry or registration results. */
export interface VisualTracker {
  track(framePaths: readonly string[], calibration: unknown): Promise<unknown>;
}

/** Ordered camera trajectory from a valid tracking result. */
export interface TrajectoryBuilder {
  buildTrajectory(trackingResult: unknown): Promise<unknown>;
}

/** Genuine point-cloud generation from frames + calibration + poses. */
export interface PointCloudReconstructor {
  reconstruct(inputs: {
    framePaths: readonly string[];
    calibration: unknown;
    trajectory: unknown;
  }): Promise<unknown>;
}

/** Aligns ≥2 genuine point-cloud inputs; never consumes camera poses. */
export interface PointCloudRegistrar {
  register(inputs: readonly string[]): Promise<unknown>;
}

/** Fuses successfully registered point clouds; refuses failed inputs. */
export interface PointCloudFuser {
  fuse(inputs: readonly string[]): Promise<unknown>;
}

export interface MeshReconstructor {
  reconstruct(pointCloudPath: string): Promise<unknown>;
}

export interface GeometryValidator {
  validate(assetPath: string): Promise<unknown>;
}

export interface ReconstructionEngine {
  readonly name: string;
  readonly frameExtractor: FrameExtractor;
  readonly visualTracker: VisualTracker;
  readonly trajectoryBuilder: TrajectoryBuilder;
  readonly pointCloudReconstructor: PointCloudReconstructor;
  readonly pointCloudRegistrar: PointCloudRegistrar;
  readonly pointCloudFuser: PointCloudFuser;
  readonly meshReconstructor: MeshReconstructor;
  readonly geometryValidator: GeometryValidator;
}

const NOT_IMPLEMENTED =
  "Reconstruction is not implemented (Stage 3). No tracking result, " +
  "trajectory, point cloud or mesh may be produced yet.";

/**
 * The only reconstruction implementation that exists. Every method rejects;
 * callers that reach one have skipped the registry guard
 * (`assertOperationImplemented`) and still fail loudly.
 */
export const unavailableReconstructionEngine: ReconstructionEngine = {
  name: "unavailable-reconstruction-engine",
  frameExtractor: {
    extractFrames: async () => {
      assertOperationImplemented("frame_extraction");
      throw new Error(NOT_IMPLEMENTED);
    },
  },
  visualTracker: {
    track: async () => {
      assertOperationImplemented("visual_tracking");
      throw new Error(NOT_IMPLEMENTED);
    },
  },
  trajectoryBuilder: {
    buildTrajectory: async () => {
      assertOperationImplemented("trajectory_generation");
      throw new Error(NOT_IMPLEMENTED);
    },
  },
  pointCloudReconstructor: {
    reconstruct: async () => {
      assertOperationImplemented("pointcloud_reconstruction");
      throw new Error(NOT_IMPLEMENTED);
    },
  },
  pointCloudRegistrar: {
    register: async () => {
      assertOperationImplemented("pointcloud_registration");
      throw new Error(NOT_IMPLEMENTED);
    },
  },
  pointCloudFuser: {
    fuse: async () => {
      assertOperationImplemented("pointcloud_fusion");
      throw new Error(NOT_IMPLEMENTED);
    },
  },
  meshReconstructor: {
    reconstruct: async () => {
      assertOperationImplemented("mesh_reconstruction");
      throw new Error(NOT_IMPLEMENTED);
    },
  },
  geometryValidator: {
    validate: async () => {
      assertOperationImplemented("pointcloud_import");
      throw new Error(NOT_IMPLEMENTED);
    },
  },
};
