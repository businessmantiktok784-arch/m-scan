# Point-cloud storage — files and database lifecycle

## Directory layout (per imported asset)

```
projects/{project_id}/assets/pointclouds/{asset_id}/
├── source/
│   └── {sanitized original filename}   # the PRESERVED copy, byte-identical
├── metadata/
│   ├── asset.json                      # pointcloud-asset v1.3 document
│   └── validation.json                 # full ValidationReport + ids
└── logs/
    └── import-log.json                 # tool identity, timings, verdict, warnings, errors
```

The source file is copied once and never modified afterwards. Filenames are
sanitized (path components stripped) but the original name is preserved
verbatim inside `asset.json.original_filename`.

## Database (migration v3)

Two tables, both created in migration v3:

- `processing_operations` — one row per long-running operation
  (`pointcloud_import` today): tool, tool_version (real app version or
  `"unknown"`), started/finished timestamps, status (`running` / `succeeded`
  / `failed` / `cancelled`), error detail.
- `pointcloud_imports` — one row per import attempt: filenames, format,
  byte size, checksum, validation verdict, `import_status`
  (`importing` / `succeeded` / `failed` / `interrupted`), `meta_json` (the
  full asset document).

**There is deliberately no foreign key from `pointcloud_imports.asset_id` to
`assets`.** The import row must exist before the asset does, so a crash
mid-import can be reconciled. The `assets` row is written in the SAME
transaction that flips `import_status` to `'succeeded'` — an atomic
all-or-nothing registration.

## Failure and crash semantics

| Event | Import row | Operation row | Assets row | Files |
|---|---|---|---|---|
| Validation failed / unsupported / incomplete | `failed` | `failed` | none | import dir deleted |
| Operator cancel | `failed` | `cancelled` | none | import dir deleted |
| App killed mid-import | `importing` (stale) | `running` (stale) | none | partial dir may remain |
| Crash reconciliation (`reconcileInterruptedImports`, on next launch) | `interrupted` | `failed` | none | partial dir left for inspection |
| Success | `succeeded` | `succeeded` | written | all kept |

A failed or interrupted import can therefore never appear in the asset list:
the `assets` row is only ever inserted inside the success transaction.

## Binaries outside SQLite

Only metadata JSON and index rows live in the database. The point-cloud
payload always lives on the filesystem; the DB stores the relative path and
checksum. SQLite is never asked to hold multi-hundred-megabyte blobs.
