/**
 * Device-capability detection — real probes via expo-camera and expo-sensors.
 *
 * Every value comes from a real API check, or is reported as
 * UNKNOWN (probe impossible here) / NOT_IMPLEMENTED (probe not built).
 * Depth/LiDAR cannot be reliably detected through Expo's managed APIs, so it
 * stays NOT_IMPLEMENTED until a native probe exists — never assumed present.
 */
import { Platform } from "react-native";
import { Camera, CameraView } from "expo-camera";
import { Accelerometer, Gyroscope, Magnetometer } from "expo-sensors";

import { sensorCapabilitySchema } from "../models/models";
import type { CapabilityState } from "../models/capture";

export interface DeviceCapabilities {
  platform: "android" | "ios";
  device_description: string;
  /** v1 Stage-1 fields kept for compatibility. null = not probed. */
  camera_available: boolean | null;
  depth_sensor_available: boolean | null;
  imu_available: boolean | null;
  checked_at: string;
  /** v1.1 additions — explicit states from real probes. */
  camera: CapabilityState;
  camera_permission: CapabilityState;
  accelerometer: CapabilityState;
  gyroscope: CapabilityState;
  magnetometer: CapabilityState;
}

async function sensorState(probe: { isAvailableAsync(): Promise<boolean> }): Promise<CapabilityState> {
  try {
    return (await probe.isAvailableAsync()) ? "AVAILABLE" : "UNAVAILABLE";
  } catch {
    return "UNKNOWN";
  }
}

export async function detectCapabilities(): Promise<DeviceCapabilities> {
  const [cameraHardware, cameraPermission, accel, gyro, mag] = await Promise.all([
    // CameraView.isAvailableAsync reports whether a camera exists at all.
    // Any probe failure degrades to null (UNKNOWN), never to a guess.
    CameraView.isAvailableAsync().catch(() => null),
    Camera.getCameraPermissionsAsync()
      .then((p) => (p.granted ? "AVAILABLE" : p.canAskAgain ? "UNKNOWN" : "PERMISSION_DENIED"))
      .catch(() => "UNKNOWN" as CapabilityState),
    sensorState(Accelerometer),
    sensorState(Gyroscope),
    sensorState(Magnetometer),
  ]);

  // Boolean compatibility fields: filled only when the probe gave a definite
  // answer; never guessed.
  const cameraAvailable = cameraHardware === null ? null : cameraHardware;
  const imuAvailable: boolean | null =
    accel === "AVAILABLE" || gyro === "AVAILABLE" ? true : accel === "UNAVAILABLE" && gyro === "UNAVAILABLE" ? false : null;

  return sensorCapabilitySchema.parse({
    platform: Platform.OS === "ios" ? "ios" : "android",
    device_description: `${Platform.OS} device, version ${Platform.Version}`,
    camera_available: cameraAvailable,
    // No reliable Expo probe exists for depth hardware: NOT_IMPLEMENTED,
    // deliberately not a guess.
    depth_sensor_available: null,
    imu_available: imuAvailable,
    checked_at: new Date().toISOString(),
    camera: cameraHardware === null ? "UNKNOWN" : cameraHardware ? "AVAILABLE" : "UNAVAILABLE",
    camera_permission: cameraPermission,
    accelerometer: accel,
    gyroscope: gyro,
    magnetometer: mag,
  }) as DeviceCapabilities;
}
