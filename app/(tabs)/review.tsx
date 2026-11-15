import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Box, CalendarClock, FileQuestion } from "lucide-react-native";

import { projectRepository } from "@/src/database/project-repository";
import { captureRepository, type CaptureSessionRecord, type StoredAsset } from "@/src/database/capture-repository";
import { theme, spacing, radius } from "@/src/theme";
import type { ProjectMetadata, ScanSession } from "@/src/models/models";

interface SessionDetail {
  capture: CaptureSessionRecord | null;
  assets: StoredAsset[];
}

/**
 * C. Project Review — real capture provenance, and the future 3D viewer area.
 *
 * All project data shown comes from the offline database and the recorder's
 * measured state. The 3D viewer is a labelled placeholder: no stage produces
 * point clouds or meshes yet, so there is nothing to render — and the capture
 * numbers below are counts of genuinely written files and samples.
 */
export default function ReviewScreen() {
  const [projects, setProjects] = useState<ProjectMetadata[] | null>(null);
  const [selected, setSelected] = useState<ProjectMetadata | null>(null);
  const [sessions, setSessions] = useState<ScanSession[] | null>(null);
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [loading, setLoading] = useState(true);

  const loadSessionDetails = useCallback(async (projectId: string, sessionId: string): Promise<SessionDetail> => {
    const [capture, assets] = await Promise.all([
      captureRepository.get(sessionId),
      captureRepository.listAssets(projectId, sessionId),
    ]);
    return { capture, assets };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await projectRepository.list();
      setProjects(list);
      const first = list[0] ?? null;
      setSelected(first);
      if (first) {
        const sessionList = await projectRepository.listSessions(first.project_id);
        setSessions(sessionList);
        const entries = await Promise.all(
          sessionList.map(async (s) => [s.session_id, await loadSessionDetails(first.project_id, s.session_id)] as const)
        );
        setDetails(Object.fromEntries(entries));
      } else {
        setSessions([]);
      }
    } catch (err) {
      Alert.alert("Database error", err instanceof Error ? err.message : String(err));
      setProjects([]);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [loadSessionDetails]);

  useEffect(() => {
    void load();
  }, [load]);

  const select = useCallback(
    async (project: ProjectMetadata) => {
      setSelected(project);
      setSessions(null);
      try {
        const sessionList = await projectRepository.listSessions(project.project_id);
        setSessions(sessionList);
        const entries = await Promise.all(
          sessionList.map(async (s) => [s.session_id, await loadSessionDetails(project.project_id, s.session_id)] as const)
        );
        setDetails(Object.fromEntries(entries));
      } catch (err) {
        Alert.alert("Database error", err instanceof Error ? err.message : String(err));
        setSessions([]);
      }
    },
    [loadSessionDetails]
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Review</Text>
        <Text style={styles.subtitle}>Project information and future 3D inspection</Text>
      </View>

      {loading && (
        <View style={styles.center}>
          <ActivityIndicator color={theme.amber} />
        </View>
      )}

      {!loading && projects && projects.length > 0 && (
        <>
          {/* 3D viewer placeholder — the honest empty state. */}
          <View style={styles.viewer}>
            <Box color={theme.textFaint} size={36} />
            <Text style={styles.viewerTitle}>3D viewer — not implemented yet</Text>
            <Text style={styles.viewerText}>
              Point-cloud and tunnel-mesh rendering arrive in later stages, together with the
              scanning engine that produces the data. There is nothing to visualise yet.
            </Text>
          </View>

          {selected && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{selected.name}</Text>
              <Text style={styles.mono}>{selected.project_id}</Text>
              <View style={styles.infoRow}>
                <CalendarClock color={theme.textFaint} size={13} />
                <Text style={styles.infoText}>
                  Created {new Date(selected.created_at).toLocaleString()}
                </Text>
              </View>
              {selected.site_name ? (
                <Text style={styles.body}>Site: {selected.site_name}</Text>
              ) : null}
              {selected.notes ? <Text style={styles.body}>{selected.notes}</Text> : null}
            </View>
          )}

          <Text style={styles.sectionTitle}>Scan sessions</Text>
          {sessions === null && <ActivityIndicator color={theme.amber} />}
          {sessions !== null && (
            <FlatList
              data={sessions}
              keyExtractor={(s) => s.session_id}
              contentContainerStyle={styles.list}
              ListEmptyComponent={
                <View style={[styles.card, { flexDirection: "row", alignItems: "center", gap: spacing.md }]}>
                  <FileQuestion color={theme.textFaint} size={18} />
                  <Text style={styles.body}>No scan sessions recorded yet.</Text>
                </View>
              }
              renderItem={({ item }) => {
                const d = details[item.session_id];
                const videos = d ? d.assets.filter((a) => a.kind === "camera_video") : [];
                const streams = d ? d.assets.filter((a) => a.kind === "sensor_stream") : [];
                const totalBytes = d ? d.assets.reduce((sum, a) => sum + a.byte_size, 0) : 0;
                const sampleLines = streams.map((s) => {
                  const kind = typeof s.meta.kind === "string" ? s.meta.kind : "unknown";
                  const count = typeof s.meta.sampleCount === "number" ? s.meta.sampleCount : null;
                  return `${kind}: ${count === null ? "sample count unknown" : `${count} samples`}`;
                });
                return (
                  <View style={styles.sessionRow}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                        <Text style={styles.sessionLabel}>{item.label}</Text>
                        <Text style={styles.sessionStatus}>{item.status}</Text>
                      </View>
                      {d ? (
                        <>
                          <Text style={styles.detailLine}>
                            Phase: {d.capture?.phase ?? "no capture record"}
                            {d.capture && d.capture.active_duration_s > 0
                              ? ` · active ${d.capture.active_duration_s.toFixed(1)} s (monotonic clock)`
                              : ""}
                            {d.capture && d.capture.interruption_count > 0
                              ? ` · ${d.capture.interruption_count} interruption${d.capture.interruption_count === 1 ? "" : "s"}`
                              : ""}
                          </Text>
                          <Text style={styles.detailLine}>
                            {videos.length} video segment{videos.length === 1 ? "" : "s"} · {streams.length} sensor stream{streams.length === 1 ? "" : "s"} · {formatBytes(totalBytes)} on disk
                          </Text>
                          {sampleLines.map((line, i) => (
                            <Text key={i} style={styles.detailLine}>{line}</Text>
                          ))}
                          {d.capture && d.capture.last_error ? (
                            <Text style={[styles.detailLine, { color: theme.amber }]}>Last error: {d.capture.last_error}</Text>
                          ) : null}
                        </>
                      ) : (
                        <Text style={styles.detailLine}>Loading capture details…</Text>
                      )}
                    </View>
                  </View>
                );
              }}
            />
          )}
        </>
      )}

      {!loading && projects && projects.length === 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Nothing to review yet</Text>
          <Text style={styles.body}>
            Create a project on the Projects tab first. Once a project exists, its metadata and
            scan sessions are reviewed here.
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
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
  viewer: {
    marginHorizontal: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: theme.outlineStrong,
    backgroundColor: theme.surface,
    alignItems: "center",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  viewerTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
  viewerText: { fontSize: 13, lineHeight: 19, color: theme.textMuted, textAlign: "center" },
  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    backgroundColor: theme.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.outline,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: theme.text },
  mono: { fontSize: 12, color: theme.textMuted, letterSpacing: 0.5 },
  infoRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  infoText: { fontSize: 12, color: theme.textFaint },
  body: { fontSize: 13, lineHeight: 19, color: theme.textMuted },
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
    fontSize: 13,
    fontWeight: "700",
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  list: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  sessionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    backgroundColor: theme.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.outline,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  sessionLabel: { fontSize: 14, color: theme.text },
  sessionStatus: { fontSize: 11, color: theme.teal, textTransform: "uppercase", letterSpacing: 0.5 },
  detailLine: { fontSize: 12, lineHeight: 17, color: theme.textMuted, fontVariant: ["tabular-nums"] },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
