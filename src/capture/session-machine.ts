/**
 * Session capture lifecycle — a pure, exhaustive state machine.
 *
 * Used by the capture recorder; screens may render its state but must never
 * bypass it. All state/transition logic is pure so it is fully testable
 * off-device.
 *
 *   idle ──prepare──▶ preparing ──ready──▶ ready ──start──▶ capturing
 *                        │                   │                 │  ▲
 *                        fail/abort          │             pause  │ resume
 *                        ▼                   ▼                 ▼  │
 *                    failed/aborted          │               paused ──▶ (back to capturing)
 *                                            │                 │
 *                                          start? no        stop ──▶ stopping ──▶ stopped
 *                     any state ──fail──▶ failed      any state ──abort──▶ aborted
 *
 * `stopped` is ONLY reachable after a real stop with recorded data. Sessions
 * that never started are `aborted`, never `collected`.
 */
export type SessionPhase =
  | "idle"
  | "preparing"
  | "ready"
  | "capturing"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed"
  | "aborted";

export type SessionEvent =
  | "prepare"
  | "ready"
  | "prepare_failed"
  | "start"
  | "pause"
  | "resume"
  | "stop"
  | "stop_done"
  | "fail"
  | "abort";

const TRANSITIONS: Record<SessionPhase, Partial<Record<SessionEvent, SessionPhase>>> = {
  idle: { prepare: "preparing", abort: "aborted" },
  preparing: { ready: "ready", prepare_failed: "failed", fail: "failed", abort: "aborted" },
  ready: { start: "capturing", abort: "aborted", fail: "failed" },
  capturing: {
    pause: "paused",
    stop: "stopping",
    fail: "failed",
    abort: "aborted",
  },
  paused: { resume: "capturing", stop: "stopping", fail: "failed", abort: "aborted" },
  stopping: { stop_done: "stopped", fail: "failed" },
  stopped: {},
  failed: {},
  aborted: {},
};

export class SessionTransitionError extends Error {
  constructor(event: SessionEvent, phase: SessionPhase) {
    super(`Event "${event}" is not allowed in session phase "${phase}"`);
    this.name = "SessionTransitionError";
  }
}

export function nextPhase(phase: SessionPhase, event: SessionEvent): SessionPhase {
  const target = TRANSITIONS[phase][event];
  if (!target) throw new SessionTransitionError(event, phase);
  return target;
}

export function canTransition(phase: SessionPhase, event: SessionEvent): boolean {
  return TRANSITIONS[phase][event] !== undefined;
}

/** A running capture occupies the device; at most one may exist. */
export function isActivePhase(phase: SessionPhase): boolean {
  return phase === "preparing" || phase === "ready" || phase === "capturing" || phase === "paused" || phase === "stopping";
}

/** Maps a machine phase to the shared scan-session status vocabulary. */
export function phaseToSessionStatus(phase: SessionPhase): "planned" | "collecting" | "collected" | "aborted" {
  switch (phase) {
    case "capturing":
    case "paused":
    case "stopping":
      return "collecting";
    case "stopped":
      return "collected";
    case "aborted":
      return "aborted";
    default:
      // idle/preparing/ready/failed keep the session `planned`: nothing has
      // been captured yet, and `failed` is stored on the capture record with
      // an error message instead of claiming a completed status.
      return "planned";
  }
}

/** Stateful wrapper used by the recorder. */
export class SessionStateMachine {
  private phase: SessionPhase;

  constructor(initial: SessionPhase = "idle") {
    this.phase = initial;
  }

  get current(): SessionPhase {
    return this.phase;
  }

  dispatch(event: SessionEvent): SessionPhase {
    this.phase = nextPhase(this.phase, event);
    return this.phase;
  }

  is(event: SessionEvent): boolean {
    return canTransition(this.phase, event);
  }

  active(): boolean {
    return isActivePhase(this.phase);
  }
}
