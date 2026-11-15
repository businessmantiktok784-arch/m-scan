# FFmpeg integration — NOT available on device (and why)

Status: **NOT integrated** in the mobile app. This document records the
decision, the reasons, and the seam that keeps a future integration honest.

## The decision

Stage 3.0's library evaluation (`docs/STAGE3_LIBRARY_EVALUATION.md`) named
FFmpeg as the frame-extraction tool. That evaluation assumed a desktop
integration. On the phone:

1. **The original Android path is gone.** `ffmpeg-kit` (the widely used
   FFmpeg mobile wrapper) was **retired by its maintainer in 2025**; its
   binaries are no longer distributed and forks are unmaintained.
2. **This build environment cannot install native modules.** The Rork
   package policy for Expo dev-client builds rejects native FFmpeg packages
   (they require custom native code that the managed build here does not
   support). There is no EAS/custom-native path in this sandbox.
3. **8 GB RAM discipline** — a full FFmpeg process per device would need
   careful memory isolation that cannot even be tested in this environment.

## What runs instead

The phone's **own platform decoder** through `expo-video-thumbnails`
(MediaMetadataRetriever on Android, AVAssetImageGenerator on iOS), converted
with `expo-image-manipulator`. It is a real decoder that renders real frames
from the real recordings — with documented limitations: seek-based, no PTS
reporting (see [frame-timestamp-provenance.md](frame-timestamp-provenance.md)).
Every provenance record names the actual tool and sets `ffmpeg_version`
to **null** — the app never claims FFmpeg ran when it did not.

## The seam that keeps the door open

`src/frame/extraction-core.ts` defines:

```ts
export interface FrameDecoder {
  readonly tool: string;            // e.g. "ffmpeg 7.1 (desktop)"
  readonly tool_version: string;
  readonly ffmpeg_version: string | null;  // ONLY when this decoder IS ffmpeg
  readonly detail: string;
  decodeAt(sourcePath, timeMs, outputDir, fileName, settings): Promise<DecodedFrame>;
}
```

The whole pipeline is invariant to the decoder: on device the injected
implementation is `RetrieverDecoder` (platform); in the bun tests it is a
decoder that shells out to a **real host FFmpeg CLI** (`tests/mobile/helpers/
extraction-host.ts`), proving the pipeline works against genuine FFmpeg
output. An offline-desktop build can inject an FFmpeg `FrameDecoder` with
zero changes to validation, sampling, verification or registration — and
would then fill `pts_ms`/`time_base` from decoder output, flip
`extraction_method` to `pts_decode`, and record `ffmpeg_version` for real.

## What FFmpeg integration must satisfy before it claims anything

1. The decoder identity (binary, version, build flags relevant to licencing)
   recorded from the binary itself — never hardcoded.
2. Licence review before bundling: FFmpeg is LGPL/GPL build-dependent
   (`docs/STAGE3_LIBRARY_EVALUATION.md` documents a real GPL build example);
   no bundling without that review.
3. PTS written only when the decoder genuinely reports it, with the time
   base; `capture_time_mapping` still requires a *measured* media →
   wall-clock mapping.
4. The same verify-before-register gate (exists, non-empty, checksummed) —
   a decoder's success message is never proof.

## Verdict

`frame_extraction` is therefore **IMPLEMENTED with a platform decoder**;
"extract with FFmpeg on device" is a NOT_AVAILABLE variant of the operation,
not a hidden default. The registry's `host` for the operation is
`mobile-or-desktop`, and the decoder actually used is recorded per job.
