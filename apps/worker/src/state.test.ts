import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isTerminal, outcomeToState } from "./state.js";

describe("job state machine", () => {
  it("allows the happy-path transitions", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("running", "requires_human_action")).toBe(true);
    expect(canTransition("requires_human_action", "running")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("succeeded", "running")).toBe(false);
    expect(canTransition("queued", "succeeded")).toBe(false);
    expect(() => assertTransition("failed", "running")).toThrow(/Illegal job transition/);
  });

  it("identifies terminal states", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });

  it("maps outcomes to terminal states (nothing_to_claim is a success)", () => {
    expect(outcomeToState("claimed")).toBe("succeeded");
    expect(outcomeToState("nothing_to_claim")).toBe("succeeded");
    expect(outcomeToState("failed")).toBe("failed");
    expect(outcomeToState("reauth_needed")).toBe("failed");
  });
});
