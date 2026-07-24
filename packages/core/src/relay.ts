/**
 * Shared contract for the CDP screencast relay (docs/design/cdp-relay.md). The worker produces
 * frames and consumes input; the wizard consumes frames and produces input; the web bridges
 * them verbatim. Keeping the message types and the coordinate mapping here means all three
 * agree on the wire format, and the mapping — the one piece with real logic — is unit-tested.
 */

/**
 * The fixed CloakBrowser viewport the worker launches with (see connectors' defaultFingerprint).
 * Screencast frames capture this viewport; operator clicks are mapped back into it in CSS px.
 */
export const RELAY_VIEWPORT = { width: 1280, height: 800 } as const;

export type MouseKind = "move" | "down" | "up" | "click";
export type MouseButton = "left" | "middle" | "right";
export type KeyAction = "down" | "up";

/** Worker → client (frames and lifecycle). */
export type WorkerToClientMsg =
  | { t: "frame"; data: string; format: "jpeg" | "png"; w: number; h: number }
  | { t: "gone" };

/** Client → worker (operator input). Coordinates are already in viewport CSS px. */
export type ClientToWorkerMsg =
  // `buttons` is the pressed-button bitmask (as in MouseEvent.buttons) — required on drag moves
  // so CDP treats them as a selection drag rather than a plain hover.
  | { t: "mouse"; kind: MouseKind; x: number; y: number; button?: MouseButton; buttons?: number }
  | { t: "wheel"; x: number; y: number; dy: number }
  // `vk` is the Windows virtual-key code; CDP needs it for editing/navigation keys (Backspace,
  // Delete, arrows, Enter…) to actually take effect. `modifiers` is the CDP modifier bitmask
  // (Alt=1, Ctrl=2, Meta=4, Shift=8) so Shift+Arrow (extend selection), Ctrl+Arrow (word jump)
  // and Ctrl/Cmd+A/C/X/Z shortcuts work.
  | { t: "key"; action: KeyAction; key: string; code?: string; text?: string; vk?: number; modifiers?: number }
  | { t: "text"; text: string };

export type RelayMsg = WorkerToClientMsg | ClientToWorkerMsg;

/**
 * Map a pointer position from the on-screen canvas (client CSS px, origin top-left of the
 * canvas) to the CloakBrowser viewport (CSS px). The canvas may be displayed at any size; the
 * frame it shows always represents the whole `viewport`, so the mapping is a simple scale.
 * Result is rounded and clamped to the viewport so a click on the very edge stays in-bounds.
 */
export function mapPointerToViewport(
  clientX: number,
  clientY: number,
  displayW: number,
  displayH: number,
  viewport: { width: number; height: number } = RELAY_VIEWPORT,
): { x: number; y: number } {
  if (displayW <= 0 || displayH <= 0) return { x: 0, y: 0 };
  const x = clamp(Math.round((clientX / displayW) * viewport.width), 0, viewport.width - 1);
  const y = clamp(Math.round((clientY / displayH) * viewport.height), 0, viewport.height - 1);
  return { x, y };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Narrowing parse of an untrusted JSON string into a relay message, or null if malformed. */
export function parseRelayMsg(raw: string): RelayMsg | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || typeof (obj as { t?: unknown }).t !== "string") {
    return null;
  }
  return obj as RelayMsg;
}
