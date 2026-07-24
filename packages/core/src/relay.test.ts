import { describe, expect, it } from "vitest";
import { mapPointerToViewport, parseRelayMsg, RELAY_VIEWPORT } from "./relay.js";

describe("mapPointerToViewport", () => {
  it("maps the canvas centre to the viewport centre", () => {
    const p = mapPointerToViewport(320, 200, 640, 400);
    expect(p).toEqual({ x: RELAY_VIEWPORT.width / 2, y: RELAY_VIEWPORT.height / 2 });
  });

  it("scales up from a small display to the full viewport", () => {
    // Canvas displayed at half size: a click at its bottom-right maps near the viewport edge.
    const p = mapPointerToViewport(640, 400, 640, 400);
    expect(p).toEqual({ x: RELAY_VIEWPORT.width - 1, y: RELAY_VIEWPORT.height - 1 });
  });

  it("clamps out-of-bounds coordinates into the viewport", () => {
    const p = mapPointerToViewport(9999, -50, 640, 400);
    expect(p.x).toBe(RELAY_VIEWPORT.width - 1);
    expect(p.y).toBe(0);
  });

  it("returns the origin for a zero-sized display", () => {
    expect(mapPointerToViewport(10, 10, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe("parseRelayMsg", () => {
  it("parses a valid message", () => {
    expect(parseRelayMsg('{"t":"text","text":"hi"}')).toEqual({ t: "text", text: "hi" });
  });

  it("rejects malformed JSON", () => {
    expect(parseRelayMsg("not json")).toBeNull();
  });

  it("rejects objects without a string tag", () => {
    expect(parseRelayMsg('{"x":1}')).toBeNull();
    expect(parseRelayMsg("42")).toBeNull();
    expect(parseRelayMsg("null")).toBeNull();
  });
});
