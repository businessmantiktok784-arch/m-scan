/**
 * CaptureRecorder — orchestrates one genuine capture session.
 *
 * What it actually does (and nothing more):
 *  - Records real camera video in segments through expo-camera's
 *    CameraView.recordAsync (mute — no microphone), finalized into the
 *    session's camera/ directory with checksums.
 *  - Samples real accelerometer / gyroscope / magnetometer data through
 *    expo-sensors, validated and appended as JSONL in batches.
 *  - Drives the pure SessionStateMachine and persists every phase change
 *    through captureRepository.
 *  - Reacts to app backgrounding by pausing the session (recorded as an
 *    interruption; completeness is never assumed).
 *
 * What it deliberately does NOT do: any SLAM, pose estimation, depth
 * acquisition or point-cloud work. High-frequency raw frame access is not
 * available through Expo's managed camera API — see
 * docs/tracking-evaluation.md for the documented native-module requirement.
 * Nothing here fabricates a frame, a sample or a measurement.
 */
import { AppState, type AppStateStatus } from "react-native";
import type { CameraViewRef } from "expo-camera";

import { shortId } from "../models/models";
import type { CameraRecording, CaptureConfig, SensorKind, SensorSample, SensorStream } from "../models/capture";
import { SENSOR_UNITS } from "../models/capture";
import { SessionStateMachine, type SessionPhase } from "./session-machine";
import { captureTimestamp, monotonicDeltaS } from "./time";
import { interruptionWarning } from "./manifest";
import { captureRepository } from "../database/capture-repository";
import {
  JsonlAppender,
  MIN_FREE_BYTES,
  StorageError,
  ensureSessionDirectories,
  finalizeInto,
  fileMeta,
  freeDiskBytes,
  writeJsonAtomic,
  type SessionDirectories,
} from "../storage/session-store";

/** Flat sensor reading handed to the recorder by a SensorSource. */
export interface RawSensorSample {
  epoch_ms: number;
  monotonic_ms: number;
  monotonic_source: "performance.now";
  axes: { x: number; y: number; z: number };
}

/** Sensor sampling facade — injectable so automated tests can simulate. */
export interface SensorSource {
  kind: SensorKind;
  requestedIntervalMs: number;
  /** Returns a stop function; samples arrive via onSample. */
  subscribe(onSample: (sample: RawSensorSample) => void): () => void;
}

export interface RecorderHooks {
  sensorSources: () => SensorSource[];
  /** Finalizes a camera segment: resolves when the OS hands over the file. */
  recordSegment: (maxDurationS: number) => Promise<{ uri: string } | null>;
  stopSegment: () => void;
  onPhaseChanged?: (phase: SessionPhase) => void;
  onError?: (message: string) => void;
}

const SENSOR_FLUSH_SAMPLES = 20;
const SENSOR_FLUSH_MS = 2000;

interface StreamState {
  streamId: string;
  kind: SensorKind;
  appender: JsonlAppender;
  stintStart: { epoch_ms: number; monotonic_ms: number; monotonic_source: "performance.now" };
  buffer: string[];
  lastSampleMono: number | null;
  flushTimer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
}

export class CaptureRecorder {
  private machine = new SessionStateMachine();
  private dirs: SessionDirectories | null = null;
  private projectId: string | null = null;
  private config: CaptureConfig | null = null;
  // Public so screens can show which session is bound to this recorder.
  sessionId: string | null = null;
  private streams = new Map<SensorKind, StreamState>();
  private segmentIndex = 0;
  private segmentLoopRunning = false;
  private accumulatedActiveS = 0;
  private stintStart: { epoch_ms: number; monotonic_ms: number; monotonic_source: "performance.now" } | null = null;
  private warnings: string[] = [];
  private appStateSub: { remove(): void } | null = null;

  constructor(private readonly hooks: RecorderHooks) {}

  get phase(): SessionPhase {
    return this.machine.current;
  }

  /** True while this recorder holds an active (occupying) session. */
  active(): boolean {
    return this.machine.active();
  }

  /** Live UI snapshot; every number is measured, never estimated. */
  snapshot(): {
    phase: SessionPhase;
    elapsedS: number;
    segments: number;
    samplesByKind: Record<string, number>;
  } {
    const live = this.stintStart ? (captureTimestamp().monotonic_ms - this.stintStart.monotonic_ms) / 1000 : 0;
    const samplesByKind: Record<string, number> = {};
    for (const [kind, st] of this.streams) samplesByKind[kind] = st.appender.sampleCount;
    return {
      phase: this.machine.current,
      elapsedS: Math.max(0, this.accumulatedActiveS + (this.machine.current === "capturing" ? live : 0)),
      segments: this.segmentIndex,
      samplesByKind,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async prepare(projectId: string, config: CaptureConfig): Promise<string> {
    if (this.machine.active()) throw new Error("A capture is already active on this recorder.");
    this.machine.dispatch("prepare");

    const free = await freeDiskBytes();
    if (free !== 0 && free < MIN_FREE_BYTES) {
      this.machine.dispatch("prepare_failed");
      throw new StorageError(
        `Insufficient storage: ${(free / 1e9).toFixed(2)} GB free, ${(MIN_FREE_BYTES / 1e9).toFixed(2)} GB required.`
      );
    }

    const sessionId = shortId("SES", randomHex());
    try {
      await captureRepository.begin({ projectId, sessionId, label: `Capture ${new Date().toLocaleString()}`, config });
      this.dirs = ensureSessionDirectories(projectId, sessionId);
    } catch (err) {
      this.machine.dispatch("prepare_failed");
      this.sessionId = null;
      throw err;
    }

    this.projectId = projectId;
    this.sessionId = sessionId;
    this.config = config;
    this.warnings = [];
    await captureRepository.updatePhase(sessionId, "ready");
    this.machine.dispatch("ready");
    this.writeManifest("paused");
    this.hooks.onPhaseChanged?.(this.machine.current);
    return sessionId;
  }

  async start(): Promise<void> {
    this.assertSession();
    this.machine.dispatch("start");
    await captureRepository.updatePhase(this.sessionId!, "capturing");
    this.stintStart = captureTimestamp();
    await this.startSensors();
    void this.runSegmentLoop(); // async: resolves segments as they finish
    this.watchAppState();
    this.hooks.onPhaseChanged?.(this.machine.current);
  }

  async pause(reason = "operator_paused"): Promise<void> {
    this.assertSession();
    this.machine.dispatch("pause");
    this.accumulateStint();
    this.hooks.stopSegment(); // ends the in-flight segment; loop finalizes it
    await this.stopSensors();
    await captureRepository.addInterruption(this.sessionId!);
    this.warnings.push(interruptionWarning(reason, "paused"));
    await captureRepository.updatePhase(this.sessionId!, "paused");
    this.writeManifest("paused");
    this.hooks.onPhaseChanged?.(this.machine.current);
  }

  async resume(): Promise<void> {
    this.assertSession();
    this.machine.dispatch("resume");
    await captureRepository.updatePhase(this.sessionId!, "capturing");
    this.stintStart = captureTimestamp();
    await this.startSensors(); // fresh stream files per stint
    void this.runSegmentLoop();
    this.hooks.onPhaseChanged?.(this.machine.current);
  }

  async stop(): Promise<void> {
    this.assertSession();
    this.machine.dispatch("stop");
    this.accumulateStint();
    this.hooks.stopSegment();
    // Give the segment loop a moment to finalize the last file, then close.
    await this.waitForSegmentLoop();
    await this.stopSensors();
    const ended = captureTimestamp();
    await captureRepository.markEnded(this.sessionId!, ended, this.accumulatedActiveS);
    await captureRepository.updatePhase(this.sessionId!, "stopped");
    this.machine.dispatch("stop_done");
    this.writeManifest("stopped");
    this.unwatchAppState();
    this.hooks.onPhaseChanged?.(this.machine.current);
  }

  async fail(message: string): Promise<void> {
    if (this.machine.current === "failed") return;
    this.accumulateStint();
    this.hooks.stopSegment();
    await this.waitForSegmentLoop().catch(() => undefined);
    await this.stopSensors().catch(() => undefined);
    if (this.sessionId) {
      this.warnings.push(`Failure: ${message}`);
      await captureRepository.updatePhase(this.sessionId, "failed", { error: message }).catch(() => undefined);
    }
    try {
      this.machine.dispatch("fail");
    } catch {
      // already in a terminal state
    }
    this.writeManifest("failed");
    this.unwatchAppState();
    this.hooks.onError?.(message);
    this.hooks.onPhaseChanged?.(this.machine.current);
  }

  async abort(): Promise<void> {
    this.accumulateStint();
    this.hooks.stopSegment();
    await this.waitForSegmentLoop().catch(() => undefined);
    await this.stopSensors().catch(() => undefined);
    if (this.sessionId) await captureRepository.updatePhase(this.sessionId, "aborted").catch(() => undefined);
    try {
      this.machine.dispatch("abort");
    } catch {
      // already terminal
    }
    this.writeManifest("aborted");
    this.unwatchAppState();
    this.hooks.onPhaseChanged?.(this.machine.current);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertSession(): void {
    if (!this.sessionId || !this.projectId || !this.dirs) throw new Error("No prepared capture session.");
  }

  private accumulateStint(): void {
    if (this.stintStart) {
      const now = captureTimestamp();
      this.accumulatedActiveS += monotonicDeltaS(this.stintStart, now);
      this.stintStart = null;
    }
  }

  private async runSegmentLoop(): Promise<void> {
    if (this.segmentLoopRunning) return;
    this.segmentLoopRunning = true;
    try {
      while (this.machine.current === "capturing") {
        const segIndex = ++this.segmentIndex;
        const result = await this.hooks
          .recordSegment(this.config!.camera.segment_duration_s)
          .catch((err: unknown) => {
            void this.fail(`Camera recording failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          });
        if (!result?.uri) break; // stopped or failed elsewhere
        if (this.machine.current === "capturing" || this.machine.current === "paused") {
          await this.finalizeSegment(result.uri, segIndex);
        }
      }
    } finally {
      this.segmentLoopRunning = false;
    }
  }

  private waitForSegmentLoop(): Promise<void> {
    const started = Date.now();
    return new Promise((resolve) => {
      const poll = () => {
        if (!this.segmentLoopRunning || Date.now() - started > 5000) resolve();
        else setTimeout(poll, 100);
      };
      poll();
    });
  }

  private async finalizeSegment(sourceUri: string, index: number): Promise<void> {
    const name = `segment-${String(index).padStart(4, "0")}.mp4`;
    try {
      const file = finalizeInto(this.dirs!.cameraDir, sourceUri, name);
      const meta = fileMeta(file);
      const recording: CameraRecording = {
        recording_id: shortId("VID", randomHex()),
        session_id: this.sessionId!,
        project_id: this.projectId!,
        file_path: `sessions/${this.sessionId}/camera/${name}`,
        media_type: "video/mp4",
        byte_size: meta.byte_size,
        checksum_md5: meta.checksum_md5,
        started_at: this.stintStart ?? captureTimestamp(),
        ended_at: captureTimestamp(),
        duration_s: null, // measured durations arrive with the player/metadata stage
        width_px: null,
        height_px: null,
        camera_facing: this.config!.camera.facing,
      };
      await captureRepository.addAsset({
        assetId: recording.recording_id,
        projectId: this.projectId!,
        sessionId: this.sessionId!,
        kind: "camera_video",
        filePath: recording.file_path,
        byteSize: meta.byte_size,
        meta: { ...recording, checksum_md5: meta.checksum_md5 },
      });
      this.writeManifest(this.machine.current === "capturing" ? "capturing" : "paused");
    } catch (err) {
      void this.fail(`Segment finalization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async startSensors(): Promise<void> {
    for (const source of this.hooks.sensorSources()) {
      if (this.streams.has(source.kind)) continue;
      const streamId = shortId("SNS", randomHex());
      const stintNo = [...this.streams.values()].filter((s) => s.kind === source.kind).length + 1;
      let appender: JsonlAppender;
      try {
        appender = new JsonlAppender(this.dirs!.sensorsDir, `${source.kind}-${String(stintNo).padStart(3, "0")}.jsonl`);
      } catch (err) {
        void this.fail(`Sensor stream could not be opened (${source.kind}): ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const state: StreamState = {
        streamId,
        kind: source.kind,
        appender,
        stintStart: captureTimestamp(),
        buffer: [],
        lastSampleMono: null,
        flushTimer: setInterval(() => void this.flushStream(state), SENSOR_FLUSH_MS),
        unsubscribe: null,
      };
      this.streams.set(source.kind, state);
      state.unsubscribe = source.subscribe((raw) => {
        const sample: SensorSample = {
          kind: source.kind,
          t: { epoch_ms: raw.epoch_ms, monotonic_ms: raw.monotonic_ms, monotonic_source: raw.monotonic_source },
          axes: raw.axes,
          delta_ms: state.lastSampleMono === null ? null : Math.max(0, raw.monotonic_ms - state.lastSampleMono),
        };
        state.lastSampleMono = raw.monotonic_ms;
        state.buffer.push(JSON.stringify(sample));
        if (state.buffer.length >= SENSOR_FLUSH_SAMPLES) void this.flushStream(state);
      });
      // state.unsubscribe is invoked in stopSensors (pause/stop/fail/abort).
    }
  }

  private async flushStream(state: StreamState): Promise<void> {
    if (state.buffer.length === 0) return;
    const lines = state.buffer.splice(0, state.buffer.length);
    try {
      state.appender.append(lines);
    } catch (err) {
      void this.fail(`Sensor write failed (${state.kind}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async stopSensors(): Promise<void> {
    for (const state of this.streams.values()) {
      if (state.flushTimer) clearInterval(state.flushTimer);
      state.unsubscribe?.();
      state.unsubscribe = null;
      await this.flushStream(state);
      const file = state.appender.close();
      const meta = fileMeta(file);
      const stream: SensorStream = {
        stream_id: state.streamId,
        session_id: this.sessionId!,
        project_id: this.projectId!,
        kind: state.kind,
        file_path: `sessions/${this.sessionId}/sensors/${file.name}`,
        media_type: "application/x-ndjson",
        units: SENSOR_UNITS[state.kind],
        requested_interval_ms: intervalFor(this.config, state.kind),
        sample_count: state.appender.sampleCount,
        byte_size: meta.byte_size,
        checksum_md5: meta.checksum_md5,
        first_sample_at: state.appender.sampleCount > 0 ? state.stintStart : null,
        last_sample_at: state.appender.sampleCount > 0 ? captureTimestamp() : null,
        finalized: true,
      };
      await captureRepository
        .addAsset({
          assetId: stream.stream_id,
          projectId: this.projectId!,
          sessionId: this.sessionId!,
          kind: "sensor_stream",
          filePath: stream.file_path,
          byteSize: meta.byte_size,
          meta: { ...stream },
        })
        .catch(() => undefined);
    }
    this.streams.clear();
  }

  private watchAppState(): void {
    this.appStateSub = AppState.addEventListener("change", (status: AppStateStatus) => {
      if (status === "background" || status === "inactive") {
        if (this.machine.current === "capturing") void this.pause("app_backgrounded");
      }
    });
  }

  private unwatchAppState(): void {
    this.appStateSub?.remove();
    this.appStateSub = null;
  }

  /** Manifest is rewritten after every meaningful change (atomic). */
  private writeManifest(finalState: "capturing" | "paused" | "stopped" | "failed" | "aborted"): void {
    if (!this.dirs || !this.sessionId || !this.projectId || !this.config) return;
    const nowIso = new Date().toISOString();
    const manifest = {
      schema_version: 1 as const,
      session_id: this.sessionId,
      project_id: this.projectId,
      config: this.config,
      created_at: nowIso,
      updated_at: nowIso,
      final_state: finalState,
      started_at: null,
      ended_at: null,
      active_duration_s: this.accumulatedActiveS,
      interruptions: [] as { at: { epoch_ms: number; monotonic_ms: number; monotonic_source: "performance.now" }; reason: string; action: "paused" | "failed" | "aborted" }[],
      camera_recordings: [] as string[],
      sensor_streams: [] as string[],
      warnings: this.warnings.slice(-20),
    };
    try {
      writeJsonAtomic(this.dirs.sessionDir, "manifest.json", manifest);
    } catch {
      // Manifest failures must not crash capture; the DB still has the facts.
      this.warnings.push("Manifest write failed — metadata lives in the device database.");
    }
  }
}

function intervalFor(config: CaptureConfig | null, kind: SensorKind): number {
  if (!config) return 100;
  const hz =
    kind === "accelerometer"
      ? config.sensors.accelerometer_hz
      : kind === "gyroscope"
        ? config.sensors.gyroscope_hz
        : config.sensors.magnetometer_hz;
  return Math.round(1000 / hz);
}

function randomHex(): string {
  let out = "";
  while (out.length < 8) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out.slice(0, 8);
}
