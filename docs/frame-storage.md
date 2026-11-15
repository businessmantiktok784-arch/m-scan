# Frame storage (Stage 3.2)

Frames are binaries in the project directory tree and rows in SQLite —
binaries never live in the database, and no image is written without a
matching record or vice versa at registration time.

## Directory layout

```
projects/<MS-xxxx>/sessions/<SES-xxxx>/frames/<JOB-xxxx>/
├── frames/                  frame_000001.png … (job-global numbering;
│                            segments share one frames/ directory, so
│                            per-segment numbering cannot silently overwrite)
├── metadata/extraction.json the full ExtractionJob record (final state)
├── metadata/frames.jsonl    one JSON line per registered frame
└── logs/extraction-log.json decoder identity, settings, sources with
                            checksums, timings, warnings, errors
```

Per-job directories make `output_exists` a hard guard: an extraction never
overwrites or merges into another job's output, and a failed run deletes
only a directory the pipeline itself created.

## SQLite (migration v4)

- **`frame_extractions`** — the job lifecycle: `extraction_status ∈
  queued/running/done/failed/cancelled/interrupted`, settings/decoder/sources
  JSON, counters, timings. `meta_json` holds the **full job record as
  registered**, so `getExtraction` works even if the app dies mid-run and
  crash reconciliation has the complete input context.
- **`frames`** — one row per verified frame: ids, source asset + segment
  index, `frame_index` (per segment), file path (relative to the job
  directory), format, dimensions, `sample_time_s`, `pts_ms`/`time_base`
  (nullable), `capture_time_mapping`, measured byte size, MD5, extraction
  method, validation status, warnings. `UNIQUE (job_id,
  source_video_asset_id, frame_index)` makes re-registration idempotent.
- **`assets`** — exactly ONE row, kind `frame_set`, asset_id = job_id,
  inserted **in the same transaction** that flips `extraction_status` to
  `done` (`frameRepository.markSucceeded`). A failed, cancelled or
  interrupted extraction registers no asset.
- **`processing_operations`** — the provenance row reused from Stage 3.1
  (`frame_extraction`, `running → succeeded/failed/cancelled`, with
  `output_asset_id` set on success).

## Lifecycles

| Event | Files | DB |
|---|---|---|
| Begin (after validation passes) | none yet | op + job rows `running`; full job in `meta_json` |
| Frame verified | image + frames.jsonl line | `frames` row (INSERT OR REPLACE) |
| All frames fail | directory removed | job `failed` (`empty_extraction`) |
| Cancel | directory removed | job `cancelled` |
| Crash | partial dir may remain | `interruptStaleExtractions` → `interrupted` on next launch; no asset ever |
| Success | extraction.json + log written | ONE transaction: assets row + `done` + op `succeeded` |

## Integrity rules

- Every frame row's byte size is **measured** after decode and its MD5 is
  computed from the stored file — checksums are never assumed.
- `frames.jsonl` mirrors the `frames` table (the portable copy); a reader
  should treat the file as the export format and the table as the index.
- Originals (the Stage 2 recordings) are opened read-only; extraction never
  modifies a source.
- Deleting a job's directory leaves the rows pointing at missing files — the
  read side must surface missing files rather than pretend they exist
  (same rule as the asset index in `docs/data-exchange.md`).
