import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CheckCircle2, ChevronDown, ChevronUp, Clock, Crosshair, FileDown, Film, FolderInput, Import, Lock, TriangleAlert, Video, Waves, XCircle } from "lucide-react-native";
import Constants from "expo-constants";

import { PLANNED_EXPORT_FORMATS } from "@/src/engine/interfaces";
import { projectRepository } from "@/src/database/project-repository";
import { captureRepository, type StoredAsset } from "@/src/database/capture-repository";
import { importPointCloud, pickPointCloudFile, reconcileInterruptedImports, type ImportStage } from "@/src/pointcloud/import-service";
import { startFrameExtraction } from "@/src/frame/extraction-service";
import { listCalibrations, reconcileInterruptedCalibrations, startCalibration } from "@/src/calibration/calibration-service";
import { frameRepository } from "@/src/database/frame-repository";
import { toRepoDb } from "@/src/database/repo-db";
import { openDatabase } from "@/src/database/db";
import { pointCloudAssetSchema, type PointCloudAsset } from "@/src/models/models";
import { theme, spacing, radius } from "@/src/theme";
import type { FrameRecord } from "@/src/frame/models";
import { calibrationRecordSchema, type CalibrationRecord } from "@/src/calibration/models";
import type { ProjectMetadata, ScanSession } from "@/src/models/models";

/**
 * D. Media & Export — real stored capture files, real point-cloud import,
 * honest export status.
 *
 * Import (Stage 3.1): a point cloud is imported only through the system
 * document picker; the file is copied, preserved unmodified, streamed
 * through validation and only registered as a PC- asset when the verdict is
 * valid or valid_with_warnings. Every number shown comes from the stored
 * record — nothing on this screen is invented.
 *
 * Frame extraction (Stage 3.2): frames are decoded from REAL Stage 2
 * recordings by the platform media framework (seek-based; the decoder does
 * not report PTS, so pts_ms stays null — shown as such). A frame set is
 * registered as an asset only after every frame verifies; tapping a frame
 * set row shows the actual stored frames with their recorded provenance.
 */
export default function ExportScreen() {
  const [projects, setProjects] = useState<ProjectMetadata[] | null>(null);
  const [selected, setSelected] = useState<ProjectMetadata | null>(null);
  const [assets, setAssets] = useState<StoredAsset[] | null>(null);
  const [importStage, setImportStage] = useState<ImportStage | null>(null);
  const [progress, setProgress] = useState(0);
  const cancelRef = useRef(false);
  const importing = importStage !== null && importStage !== "done";

  const load = useCallback(async () => {
    try {
      const list = await projectRepository.list();
      setProjects(list);
      const first = list[0] ?? null;
      setSelected(first);
      setAssets(first ? await captureRepository.listAssets(first.project_id) : []);
    } catch (err) {
      Alert.alert("Database error", err instanceof Error ? err.message : String(err));
      setProjects([]);
      setAssets([]);
    }
  }, []);

  const select = useCallback(async (project: ProjectMetadata) => {
    setSelected(project);
    setAssets(null);
    try {
      setAssets(await captureRepository.listAssets(project.project_id));
    } catch (err) {
      Alert.alert("Database error", err instanceof Error ? err.message : String(err));
      setAssets([]);
    }
  }, []);

  useEffect(() => {
    void load();
    // Crash reconciliation: stale 'importing' rows become 'interrupted',
    // stale 'running' extraction jobs become 'interrupted'.
    void reconcileInterruptedImports().catch(() => undefined);
    void reconcileInterruptedCalibrations().catch(() => undefined);
    void (async () => {
      try {
        const db = toRepoDb(await openDatabase());
        await frameRepository.interruptStaleExtractions(db, new Date().toISOString());
      } catch {
        // database not ready yet — the jobs screen surfaces status as stored
      }
    })();
  }, [load]);

  const runImport = useCallback(async () => {
    if (!selected || importing) return;
    cancelRef.current = false;
    let picked = null;
    try {
      picked = await pickPointCloudFile();
    } catch (err) {
      Alert.alert("Picker error", err instanceof Error ? err.message : String(err));
      return;
    }
    if (!picked) return;

    setProgress(0);
    setImportStage("preflight");
    try {
      const outcome = await importPointCloud({
        projectId: selected.project_id,
        picked,
        appVersion: Constants.expoConfig?.version,
        callbacks: {
          onStage: (stage) => setImportStage(stage),
          onProgress: (f) => setProgress(f),
          shouldCancel: () => cancelRef.current,
        },
      });
      if (outcome.kind === "succeeded") {
        Alert.alert(
          "Import complete",
          `${picked.name}\n${outcome.verdict === "valid" ? "Validated" : "Validated with warnings"} · ${outcome.report.point_count ?? "unknown"} points\nUnits: not documented by the file · Scale: unknown`,
        );
      } else if (outcome.kind === "cancelled") {
        Alert.alert("Import cancelled", "Nothing was registered.");
      } else {
        Alert.alert("Import failed", `${outcome.code}: ${outcome.message}`);
      }
    } catch (err) {
      Alert.alert("Import error", err instanceof Error ? err.message : String(err));
    } finally {
      setImportStage(null);
      setProgress(0);
      await select(selected);
    }
  }, [selected, importing, select]);

  const cancelImport = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const totalBytes = assets ? assets.reduce((sum, a) => sum + a.byte_size, 0) : 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Media & Export</Text>
        <Text style={styles.subtitle}>Stored files · point-cloud import · export is planned</Text>
      </View>

      {projects === null ? (
        <ActivityIndicator color={theme.amber} style={styles.center} />
      ) : projects.length > 0 ? (
        <FlatList
          data={assets ?? []}
          keyExtractor={(a) => a.asset_id}
          ListHeaderComponent={
            <View style={{ gap: spacing.md, paddingBottom: spacing.sm }}>
              <View style={styles.projectChips}>
                {projects.map((p) => (
                  <Pressable
                    key={p.project_id}
                    onPress={() => void select(p)}
                    disabled={importing}
                    style={[styles.chip, p.project_id === selected?.project_id && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, p.project_id === selected?.project_id && { color: theme.bg }]} numberOfLines={1}>
                      {p.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {selected ? (
                <>
                  <Text style={styles.sectionTitle}>{`Files for “${selected.name}” — ${formatBytes(totalBytes)} total`}</Text>
                  <ImportCard
                    importing={importing}
                    stage={importStage}
                    progress={progress}
                    onImport={() => void runImport()}
                    onCancel={cancelImport}
                  />
                  <FrameExtractionCard
                    project={selected}
                    blocked={importing}
                    onRegistered={() => void select(selected)}
                  />
                  <CalibrationCard
                    project={selected}
                    blocked={importing}
                    onRegistered={() => void select(selected)}
                  />
                </>
              ) : null}
            </View>
          }
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.card}>
              <Text style={styles.cardTitle}>No stored media yet</Text>
              <Text style={styles.body}>
                Run a capture on the Live Scan tab or import a point cloud above. Every file listed here was
                written to this device — nothing is simulated.
              </Text>
            </View>
          }
          renderItem={({ item }) =>
            item.kind === "pointcloud" ? (
              <PointCloudAssetRow asset={item} />
            ) : item.kind === "frame_set" ? (
              <FrameSetRow asset={item} />
            ) : item.kind === "camera_calibration" ? (
              <CalibrationAssetRow asset={item} />
            ) : (
              <View style={styles.assetRow}>
                {item.kind === "camera_video" ? <Video color={theme.teal} size={16} /> : <Waves color={theme.teal} size={16} />}
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.assetId}>{item.asset_id}</Text>
                  <Text style={styles.assetMeta}>
                    {item.kind === "camera_video" ? "camera video segment" : "sensor JSONL stream"}
                    {" · "}
                    {formatBytes(item.byte_size)}
                    {typeof item.meta.sampleCount === "number" ? ` · ${item.meta.sampleCount} samples` : ""}
                    {typeof item.meta.stint === "number" ? ` · stint ${item.meta.stint}` : ""}
                  </Text>
                </View>
              </View>
            )
          }
        />
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>No projects yet</Text>
          <Text style={styles.body}>Create a project first — imports attach to a project's storage.</Text>
        </View>
      )}

      <View style={styles.note}>
        <Lock color={theme.amber} size={15} />
        <Text style={styles.noteText}>
          Point-cloud import (PLY, XYZ, LAS) is implemented and keeps the original file untouched. Export is not
          built: no pipeline on this screen sends or converts any file.
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <FileDown color={theme.teal} size={16} />
          <Text style={styles.cardTitle}>Planned export formats</Text>
        </View>
        {PLANNED_EXPORT_FORMATS.map((format) => (
          <View key={format.id} style={styles.formatRow}>
            <View style={styles.formatBadge}>
              <Text style={styles.formatBadgeText}>{format.label}</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.formatNotes}>{format.notes}</Text>
              <Text style={styles.formatKind}>{format.kind}</Text>
            </View>
            <Text style={styles.plannedChip}>PLANNED</Text>
          </View>
        ))}
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------

function ImportCard(props: {
  importing: boolean;
  stage: ImportStage | null;
  progress: number;
  onImport: () => void;
  onCancel: () => void;
}) {
  const stageLabel: Record<ImportStage, string> = {
    picking: "opening picker",
    preflight: "checking file and storage",
    copying: "copying (original preserved)",
    validating: "validating (streamed)",
    finalizing: "registering asset",
    done: "finished",
  };
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Import color={theme.amber} size={16} />
        <Text style={styles.cardTitle}>Import point cloud</Text>
      </View>
      <Text style={styles.body}>
        Attach an external scan to this project. Supported: PLY (ascii / binary little-endian), XYZ,
        LAS 1.0–1.4 (header validation). LAZ is not supported on device. Units and scale are recorded as
        unknown unless the file documents them.
      </Text>
      {props.importing ? (
        <View style={{ gap: spacing.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <ActivityIndicator color={theme.amber} size="small" />
            <Text style={styles.stageText}>{props.stage ? stageLabel[props.stage] : "working"}</Text>
          </View>
          {props.stage === "validating" ? (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.round(props.progress * 100)}%` }]} />
            </View>
          ) : null}
          <Pressable style={styles.cancelButton} onPress={props.onCancel}>
            <XCircle color={theme.amber} size={15} />
            <Text style={styles.cancelText}>Cancel import</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable style={styles.importButton} onPress={props.onImport}>
          <FolderInput color={theme.bg} size={16} />
          <Text style={styles.importButtonText}>Choose file…</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Point-cloud asset row with the real stored metadata, expandable. */
function PointCloudAssetRow({ asset }: { asset: StoredAsset }) {
  const [open, setOpen] = useState(false);
  const parsed = pointCloudAssetSchema.safeParse(asset.meta);
  const meta: PointCloudAsset | null = parsed.success ? parsed.data : null;
  const verdict = meta?.validation?.verdict ?? null;
  return (
    <Pressable style={styles.assetRow} onPress={() => setOpen((v) => !v)}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          {verdict === "pass" ? (
            <CheckCircle2 color={theme.teal} size={15} />
          ) : verdict === "warn" ? (
            <TriangleAlert color={theme.amber} size={15} />
          ) : (
            <Import color={theme.teal} size={15} />
          )}
          <Text style={styles.assetId}>{asset.asset_id}</Text>
        </View>
        <Text style={styles.assetMeta}>
          imported {meta?.format ? meta.format.toUpperCase() : "point cloud"} · {formatBytes(asset.byte_size)}
          {meta?.point_count != null ? ` · ${meta.point_count.toLocaleString()} points` : " · points not counted"}
          {` · units: ${meta?.coordinate_units === "metre" ? "metre" : "not documented"}`}
          {` · scale: ${meta?.scale_status ?? "UNKNOWN"}`}
        </Text>
        {open ? (
          <View style={styles.disclosure}>
            <Text style={styles.disclosureLine}>Original file: {meta?.original_filename ?? asset.file_path}</Text>
            <Text style={styles.disclosureLine}>Coordinates stored exactly as documented in the source file.</Text>
            {meta?.content ? (
              <Text style={styles.disclosureLine}>
                CRS: {meta.content.crs ?? "none recorded"}
                {meta.content.has_colors ? " · colors present" : ""}
                {meta.content.has_normals ? " · normals present" : ""}
              </Text>
            ) : null}
            <Text style={styles.disclosureLine}>
              Validation: {verdict ?? "not recorded"}
              {meta?.validation ? ` (${meta.validation.validation_id})` : ""}
            </Text>
          </View>
        ) : null}
      </View>
      {open ? <ChevronUp color={theme.textFaint} size={15} /> : <ChevronDown color={theme.textFaint} size={15} />}
    </Pressable>
  );
}

/**
 * Stage 3.2 card: extract frames from REAL recorded capture segments.
 *
 * The operator picks a session, then the video segments inside it, then a
 * sampling mode (`time_interval` or `frame_rate`) and an output format.
 * Decoding is the platform's own (seek-based, no PTS) — the card says so
 * instead of pretending to an FFmpeg pipeline that is not integrated.
 */
function FrameExtractionCard({ project, blocked, onRegistered }: { project: ProjectMetadata; blocked: boolean; onRegistered: () => void }) {
  const [sessions, setSessions] = useState<ScanSession[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [videos, setVideos] = useState<StoredAsset[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"time_interval" | "frame_rate">("time_interval");
  const [intervalText, setIntervalText] = useState("1");
  const [fpsText, setFpsText] = useState("2");
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [stageLabel, setStageLabel] = useState("");
  const [framesDone, setFramesDone] = useState(0);
  const [framesTotal, setFramesTotal] = useState(0);
  const cancelRef = useRef(false);

  const pickSession = useCallback(
    async (id: string) => {
      setSessionId(id);
      setPicked(new Set());
      setVideos([]);
      try {
        const assets = await captureRepository.listAssets(project.project_id, id);
        setVideos(assets.filter((a) => a.kind === "camera_video"));
      } catch (err) {
        Alert.alert("Database error", err instanceof Error ? err.message : String(err));
      }
    },
    [project.project_id],
  );

  useEffect(() => {
    let alive = true;
    setSessions(null);
    setSessionId(null);
    setVideos([]);
    setPicked(new Set());
    void (async () => {
      try {
        const list = await captureRepository.listSessions(project.project_id);
        if (!alive) return;
        setSessions(list);
        const first = list[0]?.session_id ?? null;
        setSessionId(first);
        if (first) {
          const assets = await captureRepository.listAssets(project.project_id, first);
          if (!alive) return;
          setVideos(assets.filter((a) => a.kind === "camera_video"));
        }
      } catch (err) {
        if (alive) setSessions([]);
        Alert.alert("Database error", err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [project.project_id]);

  const run = useCallback(async () => {
    if (running || picked.size === 0 || !sessionId) return;
    const intervalS = Number.parseFloat(intervalText);
    const fps = Number.parseFloat(fpsText);
    if (mode === "time_interval" && (!Number.isFinite(intervalS) || intervalS <= 0)) {
      Alert.alert("Invalid interval", "Enter a positive number of seconds between frames.");
      return;
    }
    if (mode === "frame_rate" && (!Number.isFinite(fps) || fps <= 0)) {
      Alert.alert("Invalid rate", "Enter a positive frames-per-second target.");
      return;
    }
    cancelRef.current = false;
    setRunning(true);
    setFramesDone(0);
    setFramesTotal(0);
    try {
      const outcome = await startFrameExtraction({
        projectId: project.project_id,
        sessionId,
        sources: videos
          .filter((v) => picked.has(v.asset_id))
          .map((v) => ({ assetId: v.asset_id, relPath: v.file_path })),
        settings:
          mode === "time_interval"
            ? { mode, interval_s: intervalS, max_frames: 1000, image_format: format, ...(format === "jpeg" ? { jpeg_quality: 90 } : {}) }
            : { mode, target_fps: fps, max_frames: 1000, image_format: format, ...(format === "jpeg" ? { jpeg_quality: 90 } : {}) },
        hooks: {
          onStage: (s, label) => {
            setStage(s);
            setStageLabel(label);
          },
          onProgress: (done, total) => {
            setFramesDone(done);
            setFramesTotal(total);
          },
          shouldCancel: () => cancelRef.current,
        },
      });
      if (outcome.kind === "succeeded") {
        Alert.alert(
          "Extraction complete",
          `${outcome.frames_extracted} frames extracted${outcome.frames_failed ? ` · ${outcome.frames_failed} failed` : ""}\nRegistered as a frame set. Timestamps: sample positions only (decoder does not report PTS).`,
        );
      } else if (outcome.kind === "cancelled") {
        Alert.alert("Extraction cancelled", "Nothing was registered.");
      } else {
        Alert.alert("Extraction failed", `${outcome.code}: ${outcome.message}`);
      }
    } catch (err) {
      Alert.alert("Extraction error", err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setStage(null);
      onRegistered();
    }
  }, [running, picked, sessionId, videos, mode, intervalText, fpsText, format, project.project_id, onRegistered]);

  const toggle = (assetId: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Film color={theme.amber} size={16} />
        <Text style={styles.cardTitle}>Extract frames</Text>
      </View>
      <Text style={styles.body}>
        Sample real recorded video segments into review frames. Decoder: the phone's own media framework
        (seek-based). It does not report frame timestamps, so every frame records pts as null — sample
        times are the requested positions in media time, never claimed as capture wall-clock.
      </Text>

      {sessions === null ? (
        <ActivityIndicator color={theme.amber} size="small" />
      ) : sessions.length === 0 ? (
        <Text style={styles.hint}>No capture sessions yet — record one on the Live Scan tab first.</Text>
      ) : (
        <>
          <View style={styles.chipRowWrap}>
            {sessions.map((s) => (
              <Pressable
                key={s.session_id}
                onPress={() => void pickSession(s.session_id)}
                disabled={running || blocked}
                style={[styles.segChip, s.session_id === sessionId && styles.segChipActive]}
              >
                <Text style={[styles.segChipText, s.session_id === sessionId && { color: theme.bg }]} numberOfLines={1}>
                  {s.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {videos.length === 0 ? (
            <Text style={styles.hint}>This session has no stored video segments.</Text>
          ) : (
            <View style={{ gap: spacing.xs }}>
              <Text style={styles.hint}>{`Segments — ${picked.size} of ${videos.length} selected`}</Text>
              <View style={styles.chipRowWrap}>
                {videos.map((v) => (
                  <Pressable
                    key={v.asset_id}
                    onPress={() => toggle(v.asset_id)}
                    disabled={running || blocked}
                    style={[styles.segChip, picked.has(v.asset_id) && styles.segChipActive]}
                  >
                    <Text style={[styles.segChipText, picked.has(v.asset_id) && { color: theme.bg }]} numberOfLines={1}>
                      {v.file_path.split("/").pop() ?? v.asset_id}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          <View style={styles.chipRowWrap}>
            <Pressable
              onPress={() => setMode("time_interval")}
              disabled={running || blocked}
              style={[styles.segChip, mode === "time_interval" && styles.segChipActive]}
            >
              <Clock color={mode === "time_interval" ? theme.bg : theme.textMuted} size={13} />
              <Text style={[styles.segChipText, mode === "time_interval" && { color: theme.bg }]}>every N seconds</Text>
            </Pressable>
            <Pressable
              onPress={() => setMode("frame_rate")}
              disabled={running || blocked}
              style={[styles.segChip, mode === "frame_rate" && styles.segChipActive]}
            >
              <Film color={mode === "frame_rate" ? theme.bg : theme.textMuted} size={13} />
              <Text style={[styles.segChipText, mode === "frame_rate" && { color: theme.bg }]}>frames per second</Text>
            </Pressable>
          </View>

          <View style={styles.settingsRow}>
            {mode === "time_interval" ? (
              <View style={{ flex: 1 }}>
                <Text style={styles.settingsLabel}>Interval (seconds)</Text>
                <TextInput
                  style={styles.input}
                  value={intervalText}
                  onChangeText={setIntervalText}
                  keyboardType="decimal-pad"
                  editable={!running && !blocked}
                />
              </View>
            ) : (
              <View style={{ flex: 1 }}>
                <Text style={styles.settingsLabel}>Target FPS</Text>
                <TextInput
                  style={styles.input}
                  value={fpsText}
                  onChangeText={setFpsText}
                  keyboardType="decimal-pad"
                  editable={!running && !blocked}
                />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.settingsLabel}>Output</Text>
              <View style={styles.chipRowWrap}>
                <Pressable
                  onPress={() => setFormat("png")}
                  disabled={running || blocked}
                  style={[styles.segChip, format === "png" && styles.segChipActive]}
                >
                  <Text style={[styles.segChipText, format === "png" && { color: theme.bg }]}>PNG</Text>
                </Pressable>
                <Pressable
                  onPress={() => setFormat("jpeg")}
                  disabled={running || blocked}
                  style={[styles.segChip, format === "jpeg" && styles.segChipActive]}
                >
                  <Text style={[styles.segChipText, format === "jpeg" && { color: theme.bg }]}>JPEG</Text>
                </Pressable>
              </View>
            </View>
          </View>
          <Text style={styles.hint}>Cap: 1000 frames per job. Each job writes to its own folder — nothing is ever overwritten.</Text>

          {running ? (
            <View style={{ gap: spacing.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <ActivityIndicator color={theme.amber} size="small" />
                <Text style={styles.stageText}>{stage ? `${stage}: ${stageLabel}` : "working"}</Text>
              </View>
              {stage === "extracting" && framesTotal > 0 ? (
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.round((framesDone / framesTotal) * 100)}%` }]} />
                </View>
              ) : null}
              {stage === "extracting" ? <Text style={styles.hint}>{`${framesDone} of ${framesTotal} frames`}</Text> : null}
              <Pressable style={styles.cancelButton} onPress={() => (cancelRef.current = true)}>
                <XCircle color={theme.amber} size={15} />
                <Text style={styles.cancelText}>Cancel extraction</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={[styles.importButton, (picked.size === 0 || blocked) && { opacity: 0.4 }]}
              disabled={picked.size === 0 || blocked}
              onPress={() => void run()}
            >
              <Film color={theme.bg} size={16} />
              <Text style={styles.importButtonText}>{`Extract frames from ${picked.size || "no"} segment${picked.size === 1 ? "" : "s"}`}</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

/**
 * Stage 3.3 card: calibrate a camera from a real extracted frame set.
 *
 * The operator picks a completed frame set (JOB-), labels the camera and
 * describes the printed checkerboard target that was filmed. Detection,
 * quality gates and the Zhang solve run in the pure calibration core; the
 * result is registered as a CAL- asset only on success, always marked
 * "computed, not independently validated" and scale never claimed.
 */
function CalibrationCard({ project, blocked, onRegistered }: { project: ProjectMetadata; blocked: boolean; onRegistered: () => void }) {
  const [frameSets, setFrameSets] = useState<StoredAsset[] | null>(null);
  const [pickedSet, setPickedSet] = useState<string | null>(null);
  const [cameraLabel, setCameraLabel] = useState("rear camera");
  const [colsText, setColsText] = useState("6");
  const [rowsText, setRowsText] = useState("5");
  const [squareText, setSquareText] = useState("25");
  const [unit, setUnit] = useState<"mm" | "cm">("mm");
  const [boardName, setBoardName] = useState("printed checkerboard");
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [stageLabel, setStageLabel] = useState("");
  const [framesDone, setFramesDone] = useState(0);
  const [framesTotal, setFramesTotal] = useState(0);
  const [calibrations, setCalibrations] = useState<CalibrationRecord[]>([]);
  const cancelRef = useRef(false);

  const refreshCalibrations = useCallback(async () => {
    try {
      setCalibrations(await listCalibrations(project.project_id));
    } catch {
      setCalibrations([]);
    }
  }, [project.project_id]);

  useEffect(() => {
    let alive = true;
    setFrameSets(null);
    setPickedSet(null);
    void (async () => {
      try {
        const assets = await captureRepository.listAssets(project.project_id);
        if (!alive) return;
        const sets = assets.filter((a) => a.kind === "frame_set");
        setFrameSets(sets);
        setPickedSet(sets[0]?.asset_id ?? null);
      } catch {
        if (alive) setFrameSets([]);
      }
    })();
    void refreshCalibrations();
    return () => {
      alive = false;
    };
  }, [project.project_id, refreshCalibrations]);

  const run = useCallback(async () => {
    if (running || !pickedSet) return;
    const cols = Number.parseInt(colsText, 10);
    const rows = Number.parseInt(rowsText, 10);
    const square = Number.parseFloat(squareText);
    if (!Number.isInteger(cols) || cols < 2 || cols > 30) {
      Alert.alert("Invalid target", "Inner-corner columns must be an integer from 2 to 30.");
      return;
    }
    if (!Number.isInteger(rows) || rows < 2 || rows > 30) {
      Alert.alert("Invalid target", "Inner-corner rows must be an integer from 2 to 30.");
      return;
    }
    if (!Number.isFinite(square) || square <= 0) {
      Alert.alert("Invalid target", "Enter a positive square size.");
      return;
    }
    cancelRef.current = false;
    setRunning(true);
    setFramesDone(0);
    setFramesTotal(0);
    try {
      const outcome = await startCalibration({
        projectId: project.project_id,
        frameSetJobId: pickedSet,
        cameraLabel: cameraLabel.trim() || "unlabelled camera",
        target: {
          type: "checkerboard",
          corner_columns: cols,
          corner_rows: rows,
          square_size: square,
          unit,
          identification: boardName.trim() || "unidentified board",
        },
        hooks: {
          onStage: (s, label) => {
            setStage(s);
            setStageLabel(label);
          },
          onProgress: (done, total) => {
            setFramesDone(done);
            setFramesTotal(total);
          },
          shouldCancel: () => cancelRef.current,
        },
      });
      if (outcome.kind === "succeeded") {
        Alert.alert(
          "Calibration complete",
          `${outcome.reprojection_error_px === null ? "" : `RMS ${outcome.reprojection_error_px.toFixed(3)} px · `}${outcome.warnings.length ? `${outcome.warnings.length} warning(s)` : "no warnings"}\nRegistered as a CAL- asset. Result is computed from the images — NOT independently validated, and no scene scale is claimed.`,
        );
      } else if (outcome.kind === "cancelled") {
        Alert.alert("Calibration cancelled", "Nothing was registered.");
      } else {
        Alert.alert("Calibration failed", `${outcome.code}: ${outcome.message}`);
      }
    } catch (err) {
      Alert.alert("Calibration error", err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setStage(null);
      onRegistered();
      void refreshCalibrations();
    }
  }, [running, pickedSet, colsText, rowsText, squareText, unit, boardName, cameraLabel, project.project_id, onRegistered, refreshCalibrations]);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Crosshair color={theme.amber} size={16} />
        <Text style={styles.cardTitle}>Calibrate camera</Text>
      </View>
      <Text style={styles.body}>
        Solve this camera's lens and pixel geometry from a real extracted frame set filmed with a printed
        checkerboard. Engine: the app's own pure-TypeScript Zhang implementation — OpenCV is not available on
        device. Results are computed, never independently validated; scene scale is never claimed.
      </Text>

      {frameSets === null ? (
        <ActivityIndicator color={theme.amber} size="small" />
      ) : frameSets.length === 0 ? (
        <Text style={styles.hint}>No frame sets yet — extract frames from a capture session first.</Text>
      ) : (
        <>
          <View style={{ gap: spacing.xs }}>
            <Text style={styles.hint}>Frame set</Text>
            <View style={styles.chipRowWrap}>
              {frameSets.map((s) => (
                <Pressable
                  key={s.asset_id}
                  onPress={() => setPickedSet(s.asset_id)}
                  disabled={running || blocked}
                  style={[styles.segChip, pickedSet === s.asset_id && styles.segChipActive]}
                >
                  <Text style={[styles.segChipText, pickedSet === s.asset_id && { color: theme.bg }]} numberOfLines={1}>
                    {s.asset_id}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={{ gap: spacing.xs }}>
            <Text style={styles.settingsLabel}>Camera label</Text>
            <TextInput
              style={styles.input}
              value={cameraLabel}
              onChangeText={setCameraLabel}
              editable={!running && !blocked}
              placeholder="e.g. rear camera"
            />
          </View>

          <View style={{ gap: spacing.xs }}>
            <Text style={styles.settingsLabel}>Checkerboard target — inner corners (columns × rows)</Text>
            <View style={styles.settingsRow}>
              <View style={{ flex: 1 }}>
                <TextInput
                  style={styles.input}
                  value={colsText}
                  onChangeText={setColsText}
                  keyboardType="number-pad"
                  editable={!running && !blocked}
                />
              </View>
              <Text style={styles.settingsLabel}>×</Text>
              <View style={{ flex: 1 }}>
                <TextInput
                  style={styles.input}
                  value={rowsText}
                  onChangeText={setRowsText}
                  keyboardType="number-pad"
                  editable={!running && !blocked}
                />
              </View>
            </View>
            <View style={styles.settingsRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingsLabel}>Square size</Text>
                <TextInput
                  style={styles.input}
                  value={squareText}
                  onChangeText={setSquareText}
                  keyboardType="decimal-pad"
                  editable={!running && !blocked}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingsLabel}>Unit</Text>
                <View style={styles.chipRowWrap}>
                  <Pressable
                    onPress={() => setUnit("mm")}
                    disabled={running || blocked}
                    style={[styles.segChip, unit === "mm" && styles.segChipActive]}
                  >
                    <Text style={[styles.segChipText, unit === "mm" && { color: theme.bg }]}>mm</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setUnit("cm")}
                    disabled={running || blocked}
                    style={[styles.segChip, unit === "cm" && styles.segChipActive]}
                  >
                    <Text style={[styles.segChipText, unit === "cm" && { color: theme.bg }]}>cm</Text>
                  </Pressable>
                </View>
              </View>
            </View>
            <View style={{ gap: spacing.xs }}>
              <Text style={styles.settingsLabel}>Board identification</Text>
              <TextInput
                style={styles.input}
                value={boardName}
                onChangeText={setBoardName}
                editable={!running && !blocked}
                placeholder="e.g. printed A3 board #2"
              />
            </View>
          </View>
          <Text style={styles.hint}>
            Quality gates (blur, contrast, exposure, duplicates, orientation coverage) run on every image; the
            final RMS reprojection error must be under 2 px or the result is flagged with warnings.
          </Text>

          {running ? (
            <View style={{ gap: spacing.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <ActivityIndicator color={theme.amber} size="small" />
                <Text style={styles.stageText}>{stage ? `${stage}: ${stageLabel}` : "working"}</Text>
              </View>
              {stage === "evaluating" && framesTotal > 0 ? (
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.round((framesDone / framesTotal) * 100)}%` }]} />
                </View>
              ) : null}
              {stage === "evaluating" ? <Text style={styles.hint}>{`${framesDone} of ${framesTotal} frames`}</Text> : null}
              <Pressable style={styles.cancelButton} onPress={() => (cancelRef.current = true)}>
                <XCircle color={theme.amber} size={15} />
                <Text style={styles.cancelText}>Cancel calibration</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={[styles.importButton, (!pickedSet || blocked) && { opacity: 0.4 }]}
              disabled={!pickedSet || blocked}
              onPress={() => void run()}
            >
              <Crosshair color={theme.bg} size={16} />
              <Text style={styles.importButtonText}>Calibrate from this frame set</Text>
            </Pressable>
          )}

          {calibrations.length > 0 ? (
            <View style={{ gap: spacing.xs }}>
              <Text style={styles.hint}>{`${calibrations.length} calibration${calibrations.length === 1 ? "" : "s"} computed for this project`}</Text>
              {calibrations.map((c) => (
                <View key={c.calibration_id} style={styles.calRow}>
                  <Text style={styles.assetId}>{c.calibration_id}</Text>
                  <Text style={styles.frameMeta}>
                    {`${c.camera_label} · ${c.image_width}×${c.image_height} · fx ${c.fx.toFixed(1)} fy ${c.fy.toFixed(1)}`}
                  </Text>
                  <Text style={styles.frameMeta}>
                    {c.metrics.reprojection_error_px === null
                      ? "RMS not reported"
                      : `RMS ${c.metrics.reprojection_error_px.toFixed(3)} px`} ·{" "}
                    {c.metrics.frames_accepted}/{c.metrics.frames_accepted + c.metrics.frames_rejected} frames ·{" "}
                    {c.calibration_status}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

/** Registered CAL- asset row: expands into the real stored calibration record. */
function CalibrationAssetRow({ asset }: { asset: StoredAsset }) {
  const [open, setOpen] = useState(false);
  const parsed = calibrationRecordSchema.safeParse(asset.meta);
  const record: CalibrationRecord | null = parsed.success ? parsed.data : null;
  return (
    <Pressable style={styles.assetRow} onPress={() => setOpen((v) => !v)}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          {record?.calibration_status === "computed" ? (
            <CheckCircle2 color={theme.teal} size={15} />
          ) : (
            <TriangleAlert color={theme.amber} size={15} />
          )}
          <Text style={styles.assetId}>{asset.asset_id}</Text>
        </View>
        <Text style={styles.assetMeta}>
          camera calibration · {record?.camera_label ?? "camera"}
          {record?.metrics.reprojection_error_px != null ? ` · RMS ${record.metrics.reprojection_error_px.toFixed(3)} px` : ""}
          {" · computed, not independently validated"}
        </Text>
        {open && record ? (
          <View style={styles.disclosure}>
            <Text style={styles.disclosureLine}>
              {`${record.image_width}×${record.image_height} px · fx ${record.fx.toFixed(2)} · fy ${record.fy.toFixed(2)} · cx ${record.cx.toFixed(2)} · cy ${record.cy.toFixed(2)}`}
            </Text>
            <Text style={styles.disclosureLine}>
              {`Distortion [k1,k2,p1,p2,k3]: ${record.distortion.map((d) => d.toString()).join(", ")}`}
            </Text>
            <Text style={styles.disclosureLine}>
              {`${record.metrics.frames_accepted} frames accepted · ${record.metrics.frames_rejected} rejected · method ${record.calibration_method}`}
            </Text>
            <Text style={styles.disclosureLine}>Engine: {record.engine.tool} ({record.engine.tool_version})</Text>
            <Text style={styles.disclosureLine}>
              Scale: unknown — calibration is pixel geometry only, no scene scale is claimed.
            </Text>
          </View>
        ) : null}
      </View>
      {open ? <ChevronUp color={theme.textFaint} size={15} /> : <ChevronDown color={theme.textFaint} size={15} />}
    </Pressable>
  );
}

/** Registered frame-set asset: expands into the REAL stored frames with thumbnails. */
function FrameSetRow({ asset }: { asset: StoredAsset }) {
  const [open, setOpen] = useState(false);
  const [frames, setFrames] = useState<FrameRecord[] | null>(null);
  const job = asset.meta as { settings?: { mode?: string } } | null;

  const toggleOpen = useCallback(() => {
    setOpen((v) => {
      if (!v && frames === null) {
        void (async () => {
          try {
            const db = toRepoDb(await openDatabase());
            setFrames(await frameRepository.listFrames(db, asset.asset_id));
          } catch {
            setFrames([]);
          }
        })();
      }
      return !v;
    });
  }, [frames, asset.asset_id]);

  return (
    <View style={[styles.assetRow, { alignItems: "stretch" }]}>
      <Pressable onPress={toggleOpen} style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Film color={theme.teal} size={16} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.assetId}>{asset.asset_id}</Text>
          <Text style={styles.assetMeta}>
            frame set
            {job?.settings?.mode ? ` · ${job.settings.mode === "time_interval" ? "time interval" : "frame rate"}` : ""}
            {" · platform decoder (no PTS)"}
          </Text>
        </View>
        {open ? <ChevronUp color={theme.textFaint} size={15} /> : <ChevronDown color={theme.textFaint} size={15} />}
      </Pressable>
      {open ? (
        <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
          {frames === null ? (
            <ActivityIndicator color={theme.amber} size="small" />
          ) : frames.length === 0 ? (
            <Text style={styles.disclosureLine}>No frame rows found for this job.</Text>
          ) : (
            frames.map((f) => (
              <View key={f.frame_id} style={styles.frameRow}>
                <FrameThumbnail frame={f} fallbackDir={asset.file_path} />
                <View style={{ flex: 1, gap: 1 }}>
                  <Text style={styles.assetId}>{f.frame_id}</Text>
                  <Text style={styles.frameMeta}>
                    {`#${f.frame_index} · t=${f.sample_time_s.toFixed(3)}s · ${
                      f.width && f.height ? `${f.width}×${f.height}` : "size unreported"
                    } · ${formatBytes(f.byte_size)} · ${f.image_format.toUpperCase()}`}
                  </Text>
                  <Text style={styles.frameMeta}>
                    {f.pts_ms === null
                      ? "pts: not reported by the decoder — sample position only"
                      : `pts: ${f.pts_ms} ms (${f.time_base ?? "time base unreported"})`}
                    {f.warnings.length ? ` · ${f.warnings.join("; ")}` : ""}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

function FrameThumbnail({ frame, fallbackDir }: { frame: FrameRecord; fallbackDir: string }) {
  const [failed, setFailed] = useState(false);
  const uri = frame.file_path.startsWith("file:") ? frame.file_path : `file://${fallbackDir}/${frame.file_path}`;
  if (failed) {
    return <View style={styles.frameThumbMissing} />;
  }
  return <Image source={{ uri }} style={styles.frameThumb} resizeMode="cover" onError={() => setFailed(true)} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm, gap: 2 },
  title: { fontSize: 26, fontWeight: "800", color: theme.text },
  subtitle: { fontSize: 13, color: theme.textMuted },
  projectChips: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs, flexWrap: "wrap" },
  chip: { borderRadius: 999, borderWidth: 1, borderColor: theme.outlineStrong, paddingHorizontal: 14, paddingVertical: 7, maxWidth: 220 },
  chipActive: { backgroundColor: theme.amber, borderColor: theme.amber },
  chipText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: spacing.lg,
  },
  list: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.lg },
  assetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: theme.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.outline,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  assetId: { fontSize: 13, fontWeight: "600", color: theme.text, letterSpacing: 0.3 },
  assetMeta: { fontSize: 12, color: theme.textMuted, fontVariant: ["tabular-nums"] },
  disclosure: { gap: 2, marginTop: spacing.xs, paddingLeft: spacing.sm, borderLeftWidth: 2, borderLeftColor: theme.outlineStrong },
  disclosureLine: { fontSize: 11.5, lineHeight: 16, color: theme.textFaint },
  note: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: theme.amberContainer,
    borderRadius: radius.md,
    padding: spacing.md,
    marginHorizontal: spacing.lg,
  },
  noteText: { flex: 1, fontSize: 13, lineHeight: 19, color: theme.amber },
  card: {
    backgroundColor: theme.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.outline,
    padding: spacing.lg,
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cardTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
  formatRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  formatBadge: {
    width: 52,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: theme.surfaceHigh,
    alignItems: "center",
    justifyContent: "center",
  },
  formatBadgeText: { fontSize: 11, fontWeight: "800", color: theme.text, letterSpacing: 0.5 },
  formatNotes: { fontSize: 12, lineHeight: 16, color: theme.textMuted },
  formatKind: { fontSize: 10, color: theme.textFaint, textTransform: "uppercase", letterSpacing: 0.5 },
  plannedChip: { fontSize: 10, fontWeight: "700", color: theme.textFaint, letterSpacing: 0.5 },
  body: { fontSize: 13, lineHeight: 19, color: theme.textMuted },
  importButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: theme.amber,
    borderRadius: radius.md,
    paddingVertical: 12,
  },
  importButtonText: { fontSize: 14, fontWeight: "700", color: theme.bg },
  cancelButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.outlineStrong,
    paddingVertical: 10,
  },
  cancelText: { fontSize: 13, fontWeight: "600", color: theme.amber },
  stageText: { fontSize: 13, color: theme.text, flex: 1 },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: theme.surfaceHigh, overflow: "hidden" },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: theme.teal },
  center: { flex: 1 },
  hint: { fontSize: 12, lineHeight: 17, color: theme.textFaint },
  chipRowWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  segChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.outlineStrong,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  segChipActive: { backgroundColor: theme.amber, borderColor: theme.amber },
  segChipText: { color: theme.text, fontSize: 12, fontWeight: "600" },
  settingsRow: { flexDirection: "row", gap: spacing.md },
  settingsLabel: { fontSize: 11, fontWeight: "700", color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: theme.outlineStrong,
    borderRadius: radius.sm,
    backgroundColor: theme.surfaceHigh,
    color: theme.text,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
    fontVariant: ["tabular-nums"],
  },
  frameRow: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "flex-start",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.outline,
    borderRadius: radius.sm,
    padding: spacing.sm,
    backgroundColor: theme.surfaceHigh,
  },
  calRow: {
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.outline,
    borderRadius: radius.sm,
    padding: spacing.sm,
    backgroundColor: theme.surfaceHigh,
  },
  frameMeta: { fontSize: 11, lineHeight: 15, color: theme.textFaint, fontVariant: ["tabular-nums"] },
  frameThumb: { width: 64, height: 48, borderRadius: radius.sm, backgroundColor: theme.surface },
  frameThumbMissing: { width: 64, height: 48, borderRadius: radius.sm, backgroundColor: theme.surfaceHigh, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.outline },
});
