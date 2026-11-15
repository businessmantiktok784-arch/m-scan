# Point-cloud validation — how Stage 3.1 decides

Validation runs on the **preserved copy** after it is stored, streamed in
1 MiB chunks through a `ByteSource` abstraction (expo-file-system
`FileHandle` reads on device; `bun:sqlite`-side adapters in tests). Nothing
is loaded whole into memory: the validators keep only a running accumulator
(count, bounding box) and a carry buffer for binary record boundaries.

## Verdicts

| Verdict | Meaning |
|---|---|
| `valid` | Header parses, every declared vertex decodes, coordinates finite |
| `valid_with_warnings` | Valid, but with recorded caveats (e.g. trailing face element skipped, XYZ colour-like columns ignored, LAS payload not decoded) |
| `invalid` | Structurally wrong data (bad magic, missing z property, non-finite coordinates, malformed header) |
| `unsupported` / `unsupported_variant` | Real format the app intentionally does not handle (LAZ, big-endian PLY, vertex-not-first PLY) |
| `incomplete` | File ends before the header's declared data (truncated transfer) |
| `not_verified` | Validation never ran to a conclusion (cancelled) |

These verdicts are never conflated: `unsupported` is not `invalid` (the file
may be perfectly fine — for another tool), `incomplete` is not `invalid`
(the file may be re-transferred), and a cancel is reported as `not_verified`,
not as a data problem.

## Cancellation and progress

Between chunks the validator checks `shouldAbort()`; a cancel raises a
`PointCloudValidationError` carrying `"cancelled"` and verdict
`not_verified`. `onProgress` reports fraction-of-declared-bytes. Every chunk
read is counted into `checked_bytes`, which lands in the validation report —
a report always states how much of the file was actually examined.

## PLY specifics

- The header is parsed from a window of at least `max(chunkSize, 4096)`
  bytes, so even pathological 1-byte chunk reads cannot truncate the header.
- Vertex must be the FIRST element; anything else is `unsupported_variant`
  (matching the Blender-side parser).
- Scalar properties are typed from the header (`char..double`); a list
  property inside the vertex element is `parse_error`.
- Colours (red/green/blue(/alpha)) are reported as present with their stored
  integer width — never rescaled or normalized during validation.

## XYZ specifics

- ≥3 whitespace-separated values per line; extra trailing values trigger the
  `xyz_color_interpretation_ambiguous` warning and are not interpreted.
- Non-finite coordinates are counted and reported as an error with the count.

## LAS specifics

- Header block, point format/version, point count, and scale+offset fields
  are validated; VLR records are scanned for a CRS declaration.
- The point payload is not decoded — the reported `point_count` is the
  header's declared count and the report says the payload was not examined.

## Reports

Every run produces a `ValidationReport` (format, verdict, errors, warnings,
point_count, bounding_box, checked_bytes, details) which is stored verbatim
as `metadata/validation.json` and mirrored into the import log.
