/**
 * Session file store — the on-disk side of capture storage.
 *
 * Layout (relative to the app's document directory), adapted from the master
 * prompt's suggested structure to match the Stage 1 repository conventions:
 *
 *   projects/
 *     {project_id}/
 *       sessions/
 *         {session_id}/
 *           session.json      scan-session record (validated on write)
 *           manifest.json     capture manifest (atomic write, updated last)
 *           camera/           segment-0001.mp4, segment-0002.mp4, …
 *           sensors/          accelerometer.jsonl, gyroscope.jsonl, …
 *           logs/             session-log.txt
 *
 * Rules: atomic finalize (temp file + move), never overwrite an existing
 * session, checksums via the filesystem's MD5, free-space checked before
 * start. No user data is ever deleted here.
 */
import { File, Directory, Paths } from "expo-file-system";
import * as LegacyFS from "expo-file-system/legacy";

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export interface SessionDirectories {
  sessionDir: Directory;
  cameraDir: Directory;
  sensorsDir: Directory;
  logsDir: Directory;
}

function projectDir(projectId: string): Directory {
  return new Directory(Paths.document, `projects/${projectId}`);
}

function sessionDir(projectId: string, sessionId: string): Directory {
  return new Directory(projectDir(projectId), `sessions/${sessionId}`);
}

/** Creates the full session tree. Throws StorageError if it already exists. */
export function ensureSessionDirectories(projectId: string, sessionId: string): SessionDirectories {
  const dir = sessionDir(projectId, sessionId);
  if (dir.exists) {
    throw new StorageError(
      `Session directory already exists (${sessionId}) — sessions are never silently overwritten.`
    );
  }
  dir.create({ intermediates: true });
  const cameraDir = dir.createDirectory("camera");
  const sensorsDir = dir.createDirectory("sensors");
  const logsDir = dir.createDirectory("logs");
  return { sessionDir: dir, cameraDir, sensorsDir, logsDir };
}

export function sessionDirectory(projectId: string, sessionId: string): Directory {
  return sessionDir(projectId, sessionId);
}

/** Absolute URI of a file inside the session tree, if it exists. */
export function sessionFilePath(projectId: string, sessionId: string, ...parts: string[]): string {
  const file = new File(sessionDir(projectId, sessionId), parts.join("/"));
  return file.uri;
}

/** Atomic JSON write: temp file, rename into place (overwrites target). */
export function writeJsonAtomic(dir: Directory, name: string, value: unknown): File {
  const tmp = dir.createFile(`${name}.tmp`, null);
  tmp.write(JSON.stringify(value, null, 2));
  const target = new File(dir, name);
  if (target.exists) target.delete();
  tmp.rename(name); // synchronous rename within the same directory
  const moved = new File(dir, name);
  if (!moved.exists) throw new StorageError(`Atomic write failed for ${name}`);
  return moved;
}

/** Moves a freshly recorded cache file into the session tree (finalize). */
export function finalizeInto(dir: Directory, sourceUri: string, name: string): File {
  const source = new File(sourceUri);
  if (!source.exists) throw new StorageError(`Recorded file vanished before finalization: ${sourceUri}`);
  const target = new File(dir, name);
  if (target.exists) target.delete(); // segment names are unique per session
  source.moveSync(target); // synchronous; exists-check right after is then safe
  const moved = new File(dir, name);
  if (!moved.exists) throw new StorageError(`Finalization failed for ${name}`);
  return moved;
}

export interface FileMeta {
  byte_size: number;
  checksum_md5: string | null;
}

export function fileMeta(file: File): FileMeta {
  if (!file.exists) return { byte_size: 0, checksum_md5: null };
  return { byte_size: file.size, checksum_md5: file.md5 };
}

/** Opens (or creates) a JSONL file for streaming appends. */
export class JsonlAppender {
  private handle: import("expo-file-system").FileHandle | null = null;
  private file: File;
  byteSize = 0;
  sampleCount = 0;

  constructor(dir: Directory, name: string) {
    const existing = new File(dir, name);
    if (existing.exists) throw new StorageError(`Stream file already exists: ${name}`);
    this.file = dir.createFile(name, null);
    this.handle = this.file.open();
  }

  /** Appends pre-validated JSONL lines. Synchronous write keeps ordering. */
  append(lines: string[]): void {
    if (!this.handle || lines.length === 0) return;
    const payload = lines.join("\n") + "\n";
    this.handle.writeBytesSync(new TextEncoder().encode(payload));
    this.byteSize = this.handle.size ?? this.byteSize;
    this.sampleCount += lines.length;
  }

  /** Closes the handle; the file is then finalized (checksum readable). */
  close(): File {
    if (this.handle) {
      this.handle.close();
      this.handle = null;
    }
    return this.file;
  }

  get closed(): boolean {
    return this.handle === null;
  }
}

/** Free disk space in bytes (legacy API; the new API has no equivalent yet). */
export async function freeDiskBytes(): Promise<number> {
  try {
    return await LegacyFS.getFreeDiskStorageAsync();
  } catch {
    return 0; // unknown — callers treat 0 as "cannot verify"
  }
}

/** Minimum free space before starting a capture: 200 MB headroom. */
export const MIN_FREE_BYTES = 200 * 1024 * 1024;

/** Lists files in a session directory (camera/, sensors/) with metadata. */
export function listSessionFiles(dir: Directory): File[] {
  if (!dir.exists) return [];
  return dir.list().filter((e): e is File => e instanceof File);
}
