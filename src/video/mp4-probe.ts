/**
 * Stage 3.2 — pure MP4 (ISO-BMFF) box parser for video-input validation.
 *
 * Reads only what validation needs, straight from the bytes: container
 * brands, track structure, codec tags, time bases, durations, frame counts,
 * keyframe counts, edit lists (non-zero media start) and the display matrix
 * (rotation). Nothing is guessed from the extension and nothing is
 * interpreted beyond what the boxes state.
 *
 * Pure TypeScript over a `ByteSource` (chunked random access — the same
 * abstraction the point-cloud validators use), so it runs on device and in
 * bun tests against the real fixture videos in tests/fixtures/videos/.
 *
 * Honesty rules: every numeric field is null when the structure does not
 * provide it. Frame counts from stsz are sample counts of the track —
 * reported as such, not as a decoding guarantee.
 */

export interface VideoTrackInfo {
  track_id: number;
  /** FourCC of the sample description entry, e.g. "avc1", "hvc1", "mp4v". */
  codec_tag: string;
  /** Human codec name when the tag is known; null otherwise. */
  codec_name: string | null;
  /** tkhd display dimensions (after rotation is applied by the matrix). */
  width: number | null;
  height: number | null;
  /** Coded sample-description dimensions, when present. */
  coded_width: number | null;
  coded_height: number | null;
  /** Media time base from mdhd. */
  timescale: number | null;
  duration_s: number | null;
  /** Sample count from stsz (frames for a video track). */
  sample_count: number | null;
  /** Sync-sample (keyframe) count; null when the table form is unsupported. */
  sync_sample_count: number | null;
  /** True when stts has a single constant delta; null when unknown. */
  constant_framerate: boolean | null;
  /** Average frame rate = sample_count / duration_s; null when either is null. */
  avg_frame_rate: number | null;
  /** Media composition start from the edit list (elst media_time), seconds. */
  start_time_s: number | null;
  /**
   * Playable duration: the edit list's segment duration (movie timescale)
   * when a non-empty edit exists, else the mdhd duration. Sampling grids
   * must stay inside [start_time_s, start_time_s + playback_duration_s).
   */
  playback_duration_s: number | null;
  rotation_deg: 0 | 90 | 180 | 270 | null;
}

export interface Mp4Probe {
  container: "mp4";
  /** Present ftyp major brand, when the box exists. */
  major_brand: string | null;
  video_track: VideoTrackInfo | null;
  audio_tracks: number;
  /** Movie timebase from mvhd. */
  movie_timescale: number | null;
  movie_duration_s: number | null;
  /** Structural problems found while parsing (never silently ignored). */
  warnings: string[];
  /** Set when the moov box is missing entirely (incomplete recording). */
  has_moov: boolean;
}

export class VideoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoParseError";
  }
}

const KNOWN_CODECS: Record<string, string> = {
  avc1: "H.264/AVC",
  avc3: "H.264/AVC",
  hvc1: "H.265/HEVC",
  hev1: "H.265/HEVC",
  mp4v: "MPEG-4 Part 2",
  vp09: "VP9",
  av01: "AV1",
};

/** Supported video codec tags — the format family the Stage 2 recorder emits. */
export const SUPPORTED_VIDEO_CODECS = new Set(["avc1", "avc3"]);

const MAX_BOX_BYTES = 64 * 1024 * 1024; // safety cap for one box header walk

export async function probeMp4(source: ByteSourceLike): Promise<Mp4Probe> {
  const probe: Mp4Probe = {
    container: "mp4",
    major_brand: null,
    video_track: null,
    audio_tracks: 0,
    movie_timescale: null,
    movie_duration_s: null,
    warnings: [],
    has_moov: false,
  };

  const header = await source.readChunk(0, Math.min(64, source.totalSize));
  if (header.length < 12 || fourcc(header, 4) !== "ftyp") {
    throw new VideoParseError("not an MP4 container (missing ftyp box)");
  }
  probe.major_brand = fourcc(header, 8);

  // Walk top-level boxes by header only (never payload-copy whole boxes).
  let offset = 0;
  const end = source.totalSize;
  while (offset + 8 <= end) {
    const head = await source.readChunk(offset, 8);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const size = view.getUint32(0);
    const type = fourcc(head, 4);
    let headerLen = 8;
    let boxSize = size;
    if (size === 1) {
      // 64-bit largesize
      const ext = await source.readChunk(offset + 8, 8);
      const extView = new DataView(ext.buffer, ext.byteOffset, ext.byteLength);
      boxSize = Number(extView.getBigUint64(0));
      headerLen = 16;
    } else if (size === 0) {
      boxSize = end - offset; // box extends to EOF
    }
    if (boxSize < headerLen || offset + boxSize > end) {
      probe.warnings.push(`top-level box '${type}' at ${offset} declares ${boxSize} bytes beyond EOF`);
      probe.has_moov = probe.has_moov || type === "moov";
      break;
    }
    if (type === "moov") {
      probe.has_moov = true;
      await parseMoov(source, offset + headerLen, offset + boxSize, probe);
    }
    offset += boxSize;
    if (offset > MAX_BOX_BYTES * 1024) break; // absurd file — stop walking
  }
  return probe;
}

/** Minimal random-access surface (subset of the pointcloud ByteSource). */
export interface ByteSourceLike {
  readonly totalSize: number;
  readChunk(offset: number, length: number): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// moov traversal
// ---------------------------------------------------------------------------

async function parseMoov(source: ByteSourceLike, from: number, to: number, probe: Mp4Probe): Promise<void> {
  let offset = from;
  while (offset + 8 <= to) {
    const head = await source.readChunk(offset, 8);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const size = view.getUint32(0);
    const type = fourcc(head, 4);
    if (size < 8 || offset + size > to) {
      probe.warnings.push(`corrupt moov child '${type}' at ${offset}`);
      return;
    }
    if (type === "mvhd") {
      const body = await source.readChunk(offset + 8, Math.min(size - 8, 32));
      const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
      if (body[0] === 1) {
        probe.movie_timescale = v.getUint32(20);
        const dur = v.getBigUint64(24);
        probe.movie_duration_s = probe.movie_timescale ? Number(dur) / probe.movie_timescale : null;
      } else {
        probe.movie_timescale = v.getUint32(12);
        const dur = v.getUint32(16);
        probe.movie_duration_s = probe.movie_timescale ? dur / probe.movie_timescale : null;
      }
    } else if (type === "trak") {
      const track = await parseTrak(source, offset + 8, offset + size, probe.warnings, probe.movie_timescale);
      if (track) {
        if (track.handler === "vide") {
          if (probe.video_track) probe.warnings.push("multiple video tracks; all but the first are ignored");
          else probe.video_track = track.info;
        } else if (track.handler === "soun") {
          probe.audio_tracks++;
        }
      }
    }
    offset += size;
  }
}

interface TrakResult {
  handler: string | null;
  info: VideoTrackInfo;
}

async function parseTrak(
  source: ByteSourceLike,
  from: number,
  to: number,
  warnings: string[],
  movieTimescale: number | null,
): Promise<TrakResult | null> {
  const info: VideoTrackInfo = {
    track_id: 0,
    codec_tag: "",
    codec_name: null,
    width: null,
    height: null,
    coded_width: null,
    coded_height: null,
    timescale: null,
    duration_s: null,
    sample_count: null,
    sync_sample_count: null,
    constant_framerate: null,
    avg_frame_rate: null,
    start_time_s: null,
    playback_duration_s: null,
    rotation_deg: null,
  };
  let handler: string | null = null;
  let mdhdDuration: number | null = null;
  let elst: { mediaTime: number; segmentDuration: number } | null = null;

  // Walk trak children; for mdia descend into stbl too.
  const walk = async (from: number, to: number): Promise<void> => {
    let offset = from;
    while (offset + 8 <= to) {
      const head = await source.readChunk(offset, 8);
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      const size = view.getUint32(0);
      const type = fourcc(head, 4);
      if (size < 8 || offset + size > to) {
        warnings.push(`corrupt trak child '${type}' at ${offset}`);
        return;
      }
      const bodyStart = offset + 8;
      if (type === "tkhd") {
        const body = await source.readChunk(bodyStart, Math.min(size - 8, 96));
        const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const ver = body[0];
        // version+flags, then ctime/mtime (4 bytes each in v0, 8 in v1).
        const base = ver === 1 ? 20 : 12; // first byte of track_id
        info.track_id = v.getUint32(base);
        // width/height are 16.16 fixed point, last 8 bytes of the body.
        const wOff = size - 8 - 8;
        info.width = v.getUint32(wOff) / 65536 || null;
        info.height = v.getUint32(wOff + 4) / 65536 || null;
        // Display matrix: 9 x 32-bit before width/height — [a b u; c d v; x y w].
        // Rotation angle = atan2(b, a) where b is the SECOND element.
        const mOff = wOff - 36;
        const a = v.getInt32(mOff) / 65536;
        const b = v.getInt32(mOff + 4) / 65536;
        let deg = Math.round((Math.atan2(b, a) * 180) / Math.PI) % 360;
        if (deg < 0) deg += 360;
        info.rotation_deg = (deg === 0 || deg === 90 || deg === 180 || deg === 270 ? deg : null) as VideoTrackInfo["rotation_deg"];
      } else if (type === "mdia") {
        await walk(bodyStart, offset + size);
      } else if (type === "mdhd") {
        const body = await source.readChunk(bodyStart, Math.min(size - 8, 32));
        const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
        if (body[0] === 1) {
          info.timescale = v.getUint32(20);
          mdhdDuration = Number(v.getBigUint64(24));
        } else {
          info.timescale = v.getUint32(12);
          mdhdDuration = v.getUint32(16);
        }
        info.duration_s =
          info.timescale && mdhdDuration !== null ? mdhdDuration / info.timescale : null;
      } else if (type === "hdlr") {
        const body = await source.readChunk(bodyStart + 8, 4); // skip version/flags + predefined
        handler = fourcc(body, 0);
      } else if (type === "edts") {
        // elst may precede mdhd, so capture the raw edit values and convert
        // once the timescales are known (after the walk).
        elst = await parseElst(source, bodyStart, offset + size);
      } else if (type === "minf") {
        await walk(bodyStart, offset + size);
      } else if (type === "stbl") {
        await walk(bodyStart, offset + size);
      } else if (type === "stsd") {
        const body = await source.readChunk(bodyStart, Math.min(size - 8, 32));
        const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const entries = v.getUint32(4);
        if (entries >= 1) {
          // sample entry starts at bodyStart + 8; its type is at +4 bytes
          const entry = await source.readChunk(bodyStart + 8, 8);
          info.codec_tag = fourcc(entry, 4);
          info.codec_name = KNOWN_CODECS[info.codec_tag] ?? null;
          if (size - 8 >= 24) {
            const full = await source.readChunk(bodyStart + 8, 24);
            const fv = new DataView(full.buffer, full.byteOffset, full.byteLength);
            info.coded_width = fv.getUint16(8 + 8) || null;
            info.coded_height = fv.getUint16(8 + 10) || null;
          }
        }
      } else if (type === "stts") {
        const body = await source.readChunk(bodyStart, Math.min(size - 8, 4096));
        const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const entries = v.getUint32(4);
        info.constant_framerate = entries === 1;
      } else if (type === "stss") {
        const body = await source.readChunk(bodyStart, 8);
        const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
        info.sync_sample_count = v.getUint32(4);
      } else if (type === "stsz") {
        const body = await source.readChunk(bodyStart, 12);
        const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const fixed = v.getUint32(4);
        if (fixed === 0) info.sample_count = v.getUint32(8);
      }
      offset += size;
    }
  };

  await walk(from, to);
  // CFA snapshot: `elst` is assigned inside the walk closure, so TS narrows it
  // to `never` at this point — pin the declared type explicitly.
  const edit = elst as { mediaTime: number; segmentDuration: number } | null;
  if (handler === "vide") {
    if (edit && info.timescale) {
      info.start_time_s = edit.mediaTime / info.timescale;
      if (edit.segmentDuration > 0 && movieTimescale) {
        info.playback_duration_s = edit.segmentDuration / movieTimescale;
      }
    }
    if (info.playback_duration_s === null) info.playback_duration_s = info.duration_s;
    if (info.timescale && info.duration_s !== null && info.sample_count) {
      info.avg_frame_rate = info.sample_count / info.duration_s;
    }
    return { handler, info };
  }
  return handler === "soun" ? { handler, info } : null;
}

/**
 * Returns the first NON-EMPTY edit as { mediaTime (track timescale units),
 * segmentDuration (movie timescale units) }, or null. An empty edit
 * (media_time = -1) is a muxer placeholder, not a start time.
 */
async function parseElst(
  source: ByteSourceLike,
  from: number,
  to: number,
): Promise<{ mediaTime: number; segmentDuration: number } | null> {
  let offset = from;
  while (offset + 8 <= to) {
    const head = await source.readChunk(offset, 8);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const size = view.getUint32(0);
    const type = fourcc(head, 4);
    if (type === "elst" && size >= 16) {
      const body = await source.readChunk(offset + 8, Math.min(size - 8, 512));
      const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const ver = body[0];
      const count = v.getUint32(4);
      const entrySize = ver === 1 ? 20 : 12;
      let p = 8;
      for (let e = 0; e < count && p + entrySize <= body.byteLength; e++) {
        const segmentDuration = ver === 1 ? Number(v.getBigUint64(p)) : v.getUint32(p);
        const mediaTime = ver === 1 ? Number(v.getBigInt64(p + 8)) : v.getInt32(p + 4);
        if (mediaTime >= 0) return { mediaTime, segmentDuration };
        p += entrySize;
      }
      return null;
    }
    if (size < 8) return null;
    offset += size;
  }
  return null;
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
