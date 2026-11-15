# Frame timestamp provenance (Stage 3.2)

The strict rule: **a timestamp is written only when something measured it.**
This document explains exactly what each time field on a frame record means,
what the platform decoder can and cannot establish, and what stays null.

## The fields

| Field | Meaning | Platform decoder | FFmpeg (future) |
|---|---|---|---|
| `sample_time_s` | the requested seek position in **source media time** (seconds) | filled | filled |
| `pts_ms` | presentation timestamp of the frame the decoder actually returned | **null** | filled from decoder output (e.g. showinfo) |
| `time_base` | time base that `pts_ms` is expressed in | **null** | filled |
| `capture_time_mapping` | how media time maps to wall-clock capture time | `"unavailable"` | `"unavailable"`* |
| `extraction_method` | `seek_decode` / `pts_decode` | `seek_decode` | `pts_decode` (only when PTS truly reported) |

\* A PTS is a stream clock, not a wall clock. Even a PTS-reporting decoder
does not establish a media-time → capture-epoch mapping, so
`capture_time_mapping` stays `"unavailable"` unless a *measured* mapping
exists (none does for phone recordings today).

## Why `sample_time_s` is honest

The sampling grid is computed from the validated probe: it starts at the
edit-list media start (a real h264 recording carries an initial delay —
1024/15360 ≈ 0.0667 s; never fabricated to zero) and spans the edit list's
playable segment duration. Each frame records the exact position it asked
the decoder for, rounded to 6 decimals. What the frame *shows* at that
position is the decoder's rendering; with long-GOP h264 that is the nearest
decodable frame, which is why `interframe_compression` is a standing
warning.

## Why the rest is null — and must stay null

- The platform API (`MediaMetadataRetriever` / `AVAssetImageGenerator`)
  returns a rendered bitmap at a requested time and no timestamp. Writing
  the requested time into `pts_ms` would claim the decoder verified it —
  it did not. `pts_ms` stays null.
- Phone recordings provide no measurable mapping from media time to
  wall-clock capture time: the recording-start epoch and the first video
  frame differ by an unmeasurable warm-up delay. Claiming one would
  fabricate provenance. Every frame carries the explicit
  `CAPTURE_TIME_DETAIL` string stating this.

## Downstream consequence (binding)

Frames with `capture_time_mapping: "unavailable"` support **frame-order and
sample-position** reasoning only. They must never be treated as
synchronised-to-sensor capture events, and any future sensor-fusion or
trajectory stage must either (a) establish a measured mapping first, or
(b) run on timestamps that were genuinely measured. This limitation is also
stated in `docs/capture-pipeline.md` and is why the registry marks
`visual_tracking` as requiring calibration + its own provenance rules.

## Where this is enforced

- `extraction-core.ts` — fills PTS fields only from `DecodedFrame`; sets
  `extraction_method` from whether PTS exists; attaches
  `CAPTURE_TIME_DETAIL` to every frame.
- `frame/models.ts` (zod) and `schemas/frame-extraction.schema.json` (v2) —
  `pts_ms`/`time_base` nullable, `capture_time_mapping` enum.
- The bun suite asserts both directions: the platform decoder yields
  `seek_decode` + null PTS, and a PTS-reporting test decoder yields
  `pts_decode` + PTS **while** `capture_time_mapping` stays `"unavailable"`.
