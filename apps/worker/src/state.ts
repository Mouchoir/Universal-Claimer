import type { ClaimOutcome } from "@uc/connectors";

/** Job lifecycle states (data-model.md). */
export type JobState =
  | "queued"
  | "running"
  | "requires_human_action"
  | "succeeded"
  | "failed";

export const TERMINAL_STATES: readonly JobState[] = ["succeeded", "failed"];

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Allowed transitions in the job state machine. */
const TRANSITIONS: Record<JobState, JobState[]> = {
  queued: ["running", "failed"],
  running: ["requires_human_action", "succeeded", "failed"],
  requires_human_action: ["running", "failed"],
  succeeded: [],
  failed: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal job transition: ${from} -> ${to}`);
  }
}

/** Map a connector claim outcome to the terminal state it produces. */
export function outcomeToState(outcome: ClaimOutcome): Extract<JobState, "succeeded" | "failed"> {
  // "claimed" and "nothing_to_claim" are both successes; "failed" and "reauth_needed" fail.
  return outcome === "claimed" || outcome === "nothing_to_claim" ? "succeeded" : "failed";
}
