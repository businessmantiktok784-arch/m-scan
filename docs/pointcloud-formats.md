# Point-cloud formats — what Stage 3.1 accepts

Support claims here are enforced by tests against committed synthetic
fixtures; they are NOT based on a survey of real-world files (that acceptance
runs on the operator machine — see stage3.1-test-results.md).

## Support matrix

| Format | Verdict path | Notes |
|---|---|---|
| PLY ascii | Supported | Streamed header + vertex parse; colours (`uchar`/`u16` rgb(a)), normals (nx/ny/nz) and trailing face elements are recorded/skipped, never decoded as points |
| PLY binary_little_endian | Supported | Fixed-size vertex records, 1 MiB chunked reads with a carry buffer across record boundaries |
| PLY binary_big_endian | `unsupported_variant` | Rejected in the header; nothing is guessed |
| PLY vertex-not-first (e.g. face element declared before vertex) | `unsupported_variant` | Same boundary enforced in the mobile validator and the Blender parser |
| XYZ text | Supported | Whitespace-separated, ≥3 values per line; extra trailing columns are NOT interpreted as colours (a warning explains the scaling ambiguity). `#` comments and blank lines skipped |
| LAS 1.0–1.4 | Supported (header + VLR level) | Header block, point-format / version / point-count / scale+offset fields and VLR records are checked; **the point payload is NOT decoded** — the reported point count comes from the header, never from decoding |
| LAZ (compressed) | `unsupported_variant` | No decompressor ships on device; the file is rejected early with an explicit message, never misread as LAS |
| Anything else (unknown extension) | `unsupported` | |

## Units, scale, CRS

- No format path asserts a unit. Imports are recorded `unit_unknown`.
- LAS: the header's scale/offset fields are validated as present and finite
  but are not interpreted as metres; the CRS (if any) is only recorded when a
  GeoTIFF/WKT-style VLR actually declares it, and the report says so.
- XYZ/PLY: no CRS can exist in the format; `content.crs` is `null`.

## Limits

- 2 GB hard byte cap (`file_too_large`) — chosen so streamed validation plus
  the preserved copy fit in realistic phone storage with the 200 MB headroom.
- The 200 MB free-space gate is checked before anything is copied.
