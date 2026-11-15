import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { HardDrive, Plus, WifiOff } from "lucide-react-native";

import { projectRepository } from "@/src/database/project-repository";
import { captureRepository } from "@/src/database/capture-repository";
import { theme, spacing, radius } from "@/src/theme";
import type { ProjectMetadata } from "@/src/models/models";

/**
 * A. Project Dashboard — real SQLite-backed project management.
 *
 * Everything listed here was created by the operator on this device; there is
 * no seed or demo data. The database is local, so the dashboard works fully
 * offline by design.
 */
export default function DashboardScreen() {
  const [projects, setProjects] = useState<ProjectMetadata[] | null>(null);
  const [summaries, setSummaries] = useState<Map<string, { sessions: number; latestStatus: string | null; captureBytes: number }>>(new Map());
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [list, sums] = await Promise.all([
        projectRepository.list(),
        captureRepository.projectSummaries(),
      ]);
      setProjects(list);
      setSummaries(sums);
    } catch (err) {
      Alert.alert("Database error", err instanceof Error ? err.message : String(err));
      setProjects([]);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const createProject = useCallback(
    async (name: string, site: string, notes: string) => {
    setBusy(true);
    try {
      await projectRepository.create({ name, site_name: site, notes });
      await reload();
    } catch (err) {
      Alert.alert("Could not create project", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setCreating(false);
    }
    },
    [reload]
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Projects</Text>
          <Text style={styles.subtitle}>Offline-first scan projects on this device</Text>
        </View>
        <Pressable style={[styles.button, busy && { opacity: 0.6 }]} onPress={() => setCreating(true)}>
          <Plus color={theme.bg} size={16} />
          <Text style={styles.buttonTextDark}>New</Text>
        </Pressable>
      </View>

      <View style={styles.statusStrip}>
        <WifiOff color={theme.teal} size={14} />
        <Text style={styles.statusText}>Offline storage · no network required</Text>
      </View>

      {projects === null && (
        <View style={styles.center}>
          <ActivityIndicator color={theme.amber} />
        </View>
      )}

      {projects !== null && (
        <FlatList
          data={projects}
          keyExtractor={(p) => p.project_id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void reload()} tintColor={theme.amber} />}
          ListEmptyComponent={
            <View style={styles.card}>
              <Text style={styles.cardTitle}>No projects yet</Text>
              <Text style={styles.body}>
                Tap “New” to create your first scan project. It is stored in the device's offline
                database and reopened any time — nothing is uploaded anywhere.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{item.name}</Text>
              <Text style={styles.mono}>{item.project_id}</Text>
              <View style={styles.chipRow}>
                <View style={[styles.chip, { backgroundColor: theme.tealContainer }]}>
                  <Text style={[styles.chipText, { color: theme.teal }]}>{item.status}</Text>
                </View>
                {item.site_name ? (
                  <View style={[styles.chip, { backgroundColor: theme.surfaceHigh }]}>
                    <Text style={styles.chipText}>{item.site_name}</Text>
                  </View>
                ) : null}
              </View>
              {(() => {
                const s = summaries.get(item.project_id);
                if (!s) return null;
                return (
                  <View style={styles.captureBlock}>
                    <Text style={styles.captureLine}>
                      {s.sessions} capture session{s.sessions === 1 ? "" : "s"}
                      {s.latestStatus ? ` · latest: ${s.latestStatus}` : ""}
                    </Text>
                    <Text style={styles.captureLine}>
                      {s.sessions === 0
                        ? "No capture recorded yet — nothing is assumed."
                        : `${formatBytes(s.captureBytes)} of video + sensor data stored`}
                    </Text>
                  </View>
                );
              })()}
              <View style={styles.cardFooter}>
                <HardDrive color={theme.textFaint} size={13} />
                <Text style={styles.footerText}>Created {formatDate(item.created_at)}</Text>
              </View>
            </View>
          )}
        />
      )}

      {creating && (
        <CreateSheet
          busy={busy}
          onCancel={() => setCreating(false)}
          onSubmit={(name, site, notes) => {
            void createProject(name.trim(), site.trim(), notes.trim());
          }}
        />
      )}
    </SafeAreaView>
  );
}

function CreateSheet(props: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, site: string, notes: string) => void;
}) {
  const [name, setName] = useState("");
  const [site, setSite] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <View style={styles.sheetBackdrop}>
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle}>New scan project</Text>
        <Text style={styles.label}>Name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={80} placeholder="e.g. Level 3 — East decline" placeholderTextColor={theme.textFaint} />
        <Text style={styles.label}>Site (optional)</Text>
        <TextInput style={styles.input} value={site} onChangeText={setSite} maxLength={120} placeholder="e.g. Gutenberg Mine" placeholderTextColor={theme.textFaint} />
        <Text style={styles.label}>Notes (optional)</Text>
        <TextInput style={[styles.input, { minHeight: 64 }]} value={notes} onChangeText={setNotes} maxLength={2000} multiline placeholderTextColor={theme.textFaint} />
        <View style={styles.sheetRow}>
          <Pressable style={[styles.button, styles.secondary]} onPress={props.onCancel}>
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.button, (!name.trim() || props.busy) && { opacity: 0.5 }]}
            disabled={!name.trim() || props.busy}
            onPress={() => props.onSubmit(name, site, notes)}
          >
            {props.busy ? <ActivityIndicator size="small" color={theme.bg} /> : <Text style={styles.buttonTextDark}>Create</Text>}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  title: { fontSize: 26, fontWeight: "800", color: theme.text },
  subtitle: { fontSize: 13, color: theme.textMuted, marginTop: 2 },
  button: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.amber, borderRadius: 999, paddingHorizontal: spacing.lg, paddingVertical: 10 },
  secondary: { backgroundColor: theme.surfaceHigh },
  buttonText: { color: theme.text, fontWeight: "700", fontSize: 13 },
  buttonTextDark: { color: theme.bg, fontWeight: "700", fontSize: 13 },
  statusStrip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  statusText: { fontSize: 12, color: theme.teal },
  list: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  card: { backgroundColor: theme.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.outline, padding: spacing.lg, gap: spacing.sm },
  cardTitle: { fontSize: 16, fontWeight: "700", color: theme.text },
  mono: { fontSize: 12, color: theme.textMuted, letterSpacing: 0.5 },
  chipRow: { flexDirection: "row", gap: spacing.sm },
  chip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  chipText: { fontSize: 11, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5 },
  captureBlock: { backgroundColor: theme.surfaceHigh, borderRadius: radius.sm, padding: spacing.sm, gap: 2 },
  captureLine: { fontSize: 12, color: theme.textMuted, lineHeight: 17 },
  cardFooter: { flexDirection: "row", alignItems: "center", gap: 6 },
  footerText: { fontSize: 12, color: theme.textFaint },
  body: { fontSize: 13, lineHeight: 19, color: theme.textMuted },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  sheetBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: spacing.lg },
  sheet: { width: "100%", backgroundColor: theme.surfaceHigh, borderRadius: radius.xl, padding: spacing.xl, gap: spacing.sm },
  sheetTitle: { fontSize: 18, fontWeight: "800", color: theme.text },
  label: { fontSize: 12, color: theme.textMuted, marginTop: spacing.xs },
  input: { backgroundColor: theme.surface, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.outlineStrong, color: theme.text, paddingHorizontal: spacing.md, paddingVertical: 10, fontSize: 14 },
  sheetRow: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.sm },
});
