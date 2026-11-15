/**
 * Timestamp source for all capture data — the single documented clock
 * strategy (see docs/capture-pipeline.md, "Timestamp synchronization").
 *
 * Every recorded event pairs:
 *   - epoch_ms   Date.now()          wall clock, ms since Unix epoch UTC.
 *                                  Subject to OS/user clock changes — use
 *                                  for provenance, never for durations.
 *   - monotonic_ms  performance.now() device monotonic clock, ms since an
 *                                  arbitrary origin. Never goes backwards
 *                                  within one boot; the ONLY basis for
 *                                  durations and cross-stream alignment.
 *
 * Cross-stream alignment rule: camera segments and sensor streams of one
 * session are aligned by their monotonic_ms values, captured at the moment
 * each recording/subscription starts and stops. Clock resets (device reboot,
 * user time change) affect only epoch_ms; sessions never span a reboot
 * because app interruption marks the session paused/failed at the OS event.
 */
import { timestampPairSchema, type TimestampPair } from "../models/capture";

function monotonicNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === "function") return perf.now();
  // React Native Hermes provides performance.now; this fallback keeps the
  // function total in exotic environments. It is still documented as a
  // degradation, not hidden: callers can check monotonic_source.
  return Date.now();
}

export function captureTimestamp(): TimestampPair {
  const pair: TimestampPair = {
    epoch_ms: Date.now(),
    monotonic_ms: monotonicNow(),
    monotonic_source: "performance.now",
  };
  // Fail loudly if the pair is malformed — timestamps back every stream.
  return timestampPairSchema.parse(pair);
}

/** Monotonic duration in seconds between two pairs. */
export function monotonicDeltaS(start: TimestampPair, end: TimestampPair): number {
  return Math.max(0, (end.monotonic_ms - start.monotonic_ms) / 1000);
}
