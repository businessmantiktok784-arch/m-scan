/**
 * B. Live Scan — REAL capture (Stage 2).
 *
 * This screen acquires genuine camera video (segmented, muted) and genuine
 * motion-sensor samples into the selected project's session directory. It
 * also states plainly what it does NOT do: no SLAM, no poses, no point
 * clouds, no depth. Every number shown (elapsed time, sample counts,
 * segment counts) comes from the recorder's measured state.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";

/** Instance type of the CameraView class component (has recordAsync/stopRecording). */
type CameraViewInstance = InstanceType<typeof CameraView>;
import { Accelerometer, Gyroscope, Magnetometer } from "expo-sensors";
import { AlertTriangle, CircleDot, Pause, Play, Radio, Square, Video } from "lucide-react-native";

import { captureConfigDefaults, type CaptureConfig, type SensorKind } from "@/src/models/capture";
import { detectCapabilities, type DeviceCapabilities } from "@/src/services/capabilities";
import { CaptureRecorder, type SensorSource } from "@/src/capture/recorder";
import { captureTimestamp } from "@/src/capture/time";
import type { SessionPhase } from "@/src/capture/session-machine";
import { projectRepository } from "@/src/database/project-repository";
import { theme, spacing, radius } from "@/src/theme";
import type { ProjectMetadata } from "@/src/models/models";

const CAPTION: Record<SessionPhase, string> = {
  idle: "No capture prepared",
  preparing: "Preparing session…",
  ready: "Ready — start capture when positioned",
  capturing: "CAPTURING",
  paused: "Paused — data on disk is complete up to the pause point",
  stopping: "Finalizing files…",
  stopped: "Stopped — session saved",
  failed: "Capture failed",
  aborted: "Capture aborted",
};

export default function LiveScanScreen() {
  const [projects, setProjects] = useState<ProjectMetadata[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [snapshot, setSnapshot] = useState<{ elapsedS: number; segments: number; samplesByKind: Record<string, number> }>({
    elapsedS: 0,
    segments: 0,
    samplesByKind: {},
  });
  const [lastError, setLastError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef<CameraViewInstance | null>(null);
  const recorderRef = useRef<CaptureRecorder | null>(null);

  const reloadProjects = useCallback(async () => {
    try {
      const list = await projectRepository.list();
      setProjects(list);
      setProjectId((current) => current ?? list[0]?.project_id ?? null);
    } catch (err) {
      Alert.alert("Database error", err instanceof Error ? err.message : String(err));
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void reloadProjects();
    void detectCapabilities().then(setCapabilities);
  }, [reloadProjects]);

  // Elapsed-time / count ticker, 1 Hz, only while a session exists.
  useEffect(() => {
    if (phase === "idle" || phase === "stopped" || phase === "failed" || phase === "aborted") return;
    const t = setInterval(() => {
      if (recorderRef.current) setSnapshot(recorderRef.current.snapshot());
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  const selectedProject = useMemo(() => projects?.find((p) => p.project_id === projectId) ?? null, [projects, projectId]);

  const availableSensorKinds: SensorKind[] = useMemo(() => {
    if (!capabilities) return [];
    const kinds: SensorKind[] = [];
    if (capabilities.accelerometer === "AVAILABLE") kinds.push("accelerometer");
    if (capabilities.gyroscope === "AVAILABLE") kinds.push("gyroscope");
    if (capabilities.magnetometer === "AVAILABLE") kinds.push("magnetometer");
    return kinds;
  }, [capabilities]);

  const sensorSources = useCallback((): SensorSource[] => {
    const hz: Record<SensorKind, number> = {
      accelerometer: captureConfigDefaults.sensors.accelerometer_hz,
      gyroscope: captureConfigDefaults.sensors.gyroscope_hz,
      magnetometer: captureConfigDefaults.sensors.magnetometer_hz,
    };
    const mods = { accelerometer: Accelerometer, gyroscope: Gyroscope, magnetometer: Magnetometer };
    return availableSensorKinds.map((kind) => ({
      kind,
      requestedIntervalMs: Math.round(1000 / hz[kind]),
      subscribe(onSample) {
        const mod = mods[kind];
        mod.setUpdateInterval(1000 / hz[kind]);
        const sub = mod.addListener((data) => {
          // Both clocks are captured in the same instant via the shared
          // timestamp helper (see src/capture/time.ts).
          const t = captureTimestamp();
          onSample({
            epoch_ms: t.epoch_ms,
            monotonic_ms: t.monotonic_ms,
            monotonic_source: t.monotonic_source,
            axes: { x: data.x, y: data.y, z: data.z },
          });
        });
        return () => sub.remove();
      },
    }));
  }, [availableSensorKinds]);

  const makeRecorder = useCallback(() => {
    return new CaptureRecorder({
      sensorSources,
      recordSegment: (maxDurationS) =>
        cameraRef.current
          ? cameraRef.current.recordAsync({ maxDuration: maxDurationS }).then((r) => r ?? null)
          : Promise.resolve(null),
      stopSegment: () => {
        void cameraRef.current?.stopRecording();
      },
      onPhaseChanged: (p) => setPhase(p),
      onError: (message) => {
        setLastError(message);
        Alert.alert("Capture error", message);
      },
    });
  }, [sensorSources]);

  const startCapture = useCallback(async () => {
    if (!projectId || busy) return;
    setBusy(true);
    setLastError(null);
    try {
      const recorder = makeRecorder();
      recorderRef.current = recorder;
      const config: CaptureConfig = { ...captureConfigDefaults };
      await recorder.prepare(projectId, config);
      await recorder.start();
      setSnapshot(recorder.snapshot());
    } catch (err) {
      Alert.alert("Could not start capture", err instanceof Error ? err.message : String(err));
      setPhase(recorderRef.current?.phase ?? "failed");
      recorderRef.current = null;
    } finally {
      setBusy(false);
    }
  }, [projectId, busy, makeRecorder]);

  const withBusy = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      Alert.alert("Capture control failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const recorder = recorderRef.current;
  const cameraUsable = capabilities?.camera === "AVAILABLE" && permission?.granted === true;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Live Scan</Text>
          <Text style={styles.subtitle}>Real video + motion capture · offline</Text>
        </View>

        {/* Project selector */}
        <Text style={styles.label}>Capture into project</Text>
        {projects === null ? (
          <ActivityIndicator color={theme.amber} />
        ) : projects.length === 0 ? (
          <Text style={styles.body}>No projects yet — create one on the Projects tab first.</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {projects.map((p) => (
              <Pressable
                key={p.project_id}
                onPress={() => setProjectId(p.project_id)}
                disabled={recorder?.active() ?? false}
                style={[styles.projChip, p.project_id === projectId && styles.projChipActive]}
              >
                <Text style={[styles.projChipText, p.project_id === projectId && { color: theme.bg }]} numberOfLines={1}>
                  {p.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {/* Camera preview / permission states — all honest */}
        <View style={styles.viewport}>
          {cameraUsable ? (
            <CameraView ref={cameraRef} style={styles.camera} facing="back" mute videoQuality="720p" />
          ) : capabilities === null ? (
            <ActivityIndicator color={theme.amber} />
          ) : capabilities.camera === "UNAVAILABLE" ? (
            <StatusBlock icon={<Video color={theme.textFaint} size={36} />} title="No camera on this device" text="Capture requires a phone camera. This device reports none." />
          ) : permission && !permission.granted ? (
            <StatusBlock
              icon={<AlertTriangle color={theme.amber} size={36} />}
              title={permission.canAskAgain ? "Camera permission needed" : "Camera permission was denied permanently"}
              text={
                permission.canAskAgain
                  ? "Underground capture records real video of the tunnel. Nothing leaves the device."
                  : "Enable Camera access for Mining Scanner in the system Settings app, then return here."
              }
              action={
                permission.canAskAgain
                  ? { label: "Grant camera permission", onPress: () => void requestPermission() }
                  : undefined
              }
            />
          ) : (
            <StatusBlock icon={<Video color={theme.textFaint} size={36} />} title="Camera check pending" text="Capability probe has not completed yet." />
          )}
          {phase === "capturing" && (
            <View style={styles.recBadge}>
              <CircleDot color={theme.danger} size={14} />
              <Text style={styles.recBadgeText}>REC · segment {snapshot.segments}</Text>
            </View>
          )}
        </View>

        {/* Session controls + measured state */}
        <View style={styles.card}>
          <View style={styles.stateRow}>
            <Text style={[styles.stateText, phase === "capturing" && { color: theme.danger }]}>{CAPTION[phase]}</Text>
            {recorder && <Text style={styles.elapsed}>{formatElapsed(snapshot.elapsedS)}</Text>}
          </View>
          <View style={styles.controlRow}>
            <ControlButton
              label="Start"
              icon={<Play color={theme.bg} size={15} />}
              disabled={!selectedProject || busy || phase !== "idle"}
              onPress={() => void startCapture()}
              primary
            />
            <ControlButton label="Pause" icon={<Pause color={theme.text} size={15} />} disabled={phase !== "capturing" || busy} onPress={() => void withBusy(() => recorder!.pause())()} />
            <ControlButton label="Resume" icon={<Play color={theme.text} size={15} />} disabled={phase !== "paused" || busy} onPress={() => void withBusy(() => recorder!.resume())()} />
            <ControlButton label="Stop" icon={<Square color={theme.text} size={15} />} disabled={!(phase === "capturing" || phase === "paused") || busy} onPress={() => void withBusy(() => recorder!.stop())()} />
          </View>

          {/* Real acquisition status */}
          <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
            {availableSensorKinds.length === 0 && (
              <Text style={styles.body}>No motion sensors reported available — sensor recording is disabled. Nothing is simulated.</Text>
            )}
            {availableSensorKinds.map((kind) => (
              <View key={kind} style={styles.capRow}>
                <Radio color={theme.teal} size={14} />
                <Text style={styles.capLabel}>{kind}</Text>
                <Text style={styles.capValue}>{snapshot.samplesByKind[kind] ?? 0} samples</Text>
              </View>
            ))}
            <View style={styles.capRow}>
              <Video color={theme.teal} size={14} />
              <Text style={styles.capLabel}>Video segments</Text>
              <Text style={styles.capValue}>{snapshot.segments}</Text>
            </View>
          </View>

          {lastError && (
            <View style={styles.errorBox}>
              <AlertTriangle color={theme.danger} size={14} />
              <Text style={styles.errorText}>{lastError}</Text>
            </View>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Stage 2 limitations</Text>
          <Text style={styles.body}>
            This records genuine camera video and motion-sensor samples with timestamps. It does NOT produce poses,
            trajectories, point clouds or any 3D reconstruction — visual tracking is not implemented. Camera and sensor
            clocks are recorded separately and are not assumed synchronized.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatusBlock(props: { icon: React.ReactNode; title: string; text: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View style={styles.statusBlock}>
      {props.icon}
      <Text style={styles.statusTitle}>{props.title}</Text>
      <Text style={styles.statusText}>{props.text}</Text>
      {props.action && (
        <Pressable style={styles.statusButton} onPress={props.action.onPress}>
          <Text style={[styles.projChipText, { color: theme.bg }]}>{props.action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

function ControlButton(props: { label: string; icon: React.ReactNode; disabled: boolean; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={[styles.control, props.primary && !props.disabled && { backgroundColor: theme.amber }, props.disabled && { opacity: 0.4 }]}
    >
      {props.icon}
      <Text style={[styles.controlText, props.primary && !props.disabled && { color: theme.bg }]}>{props.label}</Text>
    </Pressable>
  );
}

function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  header: { gap: 2 },
  title: { fontSize: 26, fontWeight: "800", color: theme.text },
  subtitle: { fontSize: 13, color: theme.textMuted },
  label: { fontSize: 12, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: spacing.xs },
  chipRow: { gap: spacing.sm, paddingVertical: spacing.xs },
  projChip: { borderRadius: 999, borderWidth: 1, borderColor: theme.outlineStrong, paddingHorizontal: 14, paddingVertical: 8, maxWidth: 220 },
  projChipActive: { backgroundColor: theme.amber, borderColor: theme.amber },
  projChipText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  viewport: {
    borderRadius: radius.xl,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.outlineStrong,
    backgroundColor: theme.surface,
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center",
  },
  camera: { width: "100%", height: "100%", minHeight: 240 },
  recBadge: { position: "absolute", top: spacing.md, left: spacing.md, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,0.65)", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  recBadgeText: { color: "#fff", fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  statusBlock: { alignItems: "center", gap: spacing.sm, padding: spacing.xl },
  statusTitle: { fontSize: 15, fontWeight: "700", color: theme.text, textAlign: "center" },
  statusText: { fontSize: 13, lineHeight: 19, color: theme.textMuted, textAlign: "center" },
  statusButton: { backgroundColor: theme.amber, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8, marginTop: spacing.xs },
  card: { backgroundColor: theme.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.outline, padding: spacing.lg, gap: spacing.xs },
  cardTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
  stateRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  stateText: { fontSize: 14, fontWeight: "800", color: theme.text },
  elapsed: { fontSize: 22, fontWeight: "800", color: theme.text, fontVariant: ["tabular-nums"] },
  controlRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  control: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.surfaceHigh, borderRadius: radius.sm, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.outlineStrong },
  controlText: { fontSize: 12, fontWeight: "700", color: theme.text },
  capRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  capLabel: { fontSize: 13, color: theme.text, flex: 1 },
  capValue: { fontSize: 12, color: theme.textMuted, fontVariant: ["tabular-nums"] },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.amberContainer, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs },
  errorText: { flex: 1, fontSize: 12, color: theme.danger },
  body: { fontSize: 13, lineHeight: 19, color: theme.textMuted },
});
