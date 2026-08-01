// @vitest-environment jsdom
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useExpandable } from "../src/components/use-expandable.js";

/**
 * jsdom implements neither requestFullscreen nor exitFullscreen, so each test installs exactly
 * the shape it wants to exercise. That is the point: the hook has to behave on a browser that
 * grants fullscreen, one that refuses it, and one that has never heard of it.
 */

afterEach(() => {
  cleanup();
  delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen;
  delete (document as { exitFullscreen?: unknown }).exitFullscreen;
  setFullscreenElement(null);
  vi.restoreAllMocks();
});

function setFullscreenElement(el: Element | null) {
  Object.defineProperty(document, "fullscreenElement", {
    value: el,
    configurable: true,
    writable: true,
  });
}

/** Browser that grants fullscreen, tracking document.fullscreenElement as a real one would. */
function grantFullscreen() {
  const request = vi.fn(function (this: Element) {
    setFullscreenElement(this);
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    setFullscreenElement(null);
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen = request;
  (document as { exitFullscreen?: unknown }).exitFullscreen = exit;
  setFullscreenElement(null);
  return { request, exit };
}

function setup(onTransition?: () => void) {
  return renderHook(() => {
    const ref = useRef<HTMLElement | null>(null);
    if (!ref.current) ref.current = document.createElement("div");
    return useExpandable(ref, onTransition);
  });
}

describe("useExpandable", () => {
  it("starts collapsed and forwards Escape to the caller", () => {
    const { result } = setup();
    expect(result.current.expanded).toBe(false);
    expect(result.current.escapeExits).toBe(false);
  });

  it("uses the browser's fullscreen when it is granted", async () => {
    const { request } = grantFullscreen();
    const { result } = setup();

    await act(async () => result.current.toggle());

    expect(request).toHaveBeenCalled();
    expect(result.current.expanded).toBe(true);
    expect(result.current.nativeFullscreen).toBe(true);
    // The browser eats the Escape that exits fullscreen, so the wizard must keep forwarding it.
    expect(result.current.escapeExits).toBe(false);
  });

  it("collapses when the browser leaves fullscreen on its own", async () => {
    grantFullscreen();
    const { result } = setup();
    await act(async () => result.current.toggle());

    // What Escape, F11 or a tab switch produce: no call of ours, just the event.
    await act(async () => {
      setFullscreenElement(null);
      document.dispatchEvent(new Event("fullscreenchange"));
    });

    expect(result.current.expanded).toBe(false);
    expect(result.current.nativeFullscreen).toBe(false);
  });

  it("toggling while expanded asks the browser to exit", async () => {
    const { exit } = grantFullscreen();
    const { result } = setup();
    await act(async () => result.current.toggle());

    await act(async () => result.current.toggle());

    expect(exit).toHaveBeenCalled();
    expect(result.current.expanded).toBe(false);
  });

  it("falls back to CSS when the browser has no Fullscreen API, and then owns Escape", async () => {
    const { result } = setup();

    await act(async () => result.current.toggle());

    expect(result.current.expanded).toBe(true);
    expect(result.current.nativeFullscreen).toBe(false);
    // Nothing is intercepting Escape here, so the wizard has to spend it on collapsing.
    expect(result.current.escapeExits).toBe(true);

    await act(async () => result.current.collapse());
    expect(result.current.expanded).toBe(false);
  });

  it("survives a browser that refuses by throwing instead of rejecting", async () => {
    // A permissions policy on an embedding frame does exactly this. Letting the throw escape
    // aborted the click handler before the transition was signalled, so the view expanded but
    // focus stayed on the button that was clicked — every later keystroke went to the button,
    // and the console got an uncaught error.
    (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen = vi.fn(() => {
      throw new Error("fullscreen is not allowed by permissions policy");
    });
    const onTransition = vi.fn();
    const { result } = setup(onTransition);

    await act(async () => result.current.toggle());

    expect(result.current.expanded).toBe(true);
    expect(result.current.nativeFullscreen).toBe(false);
    expect(result.current.escapeExits).toBe(true);
    expect(onTransition).toHaveBeenCalled();
  });

  it("signals the transition exactly once per change", async () => {
    // settle() used to run inside a setState updater, which React is free to invoke more than
    // once — refocusing twice is harmless, but the contract violation is not.
    grantFullscreen();
    const onTransition = vi.fn();
    const { result } = setup(onTransition);

    await act(async () => result.current.toggle());
    expect(onTransition).toHaveBeenCalledTimes(1);

    await act(async () => {
      setFullscreenElement(null);
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(onTransition).toHaveBeenCalledTimes(2);

    // A stray event after we have already collapsed must not re-signal.
    await act(async () => document.dispatchEvent(new Event("fullscreenchange")));
    expect(onTransition).toHaveBeenCalledTimes(2);
  });

  it("collapses anyway when the browser refuses to leave fullscreen", async () => {
    grantFullscreen();
    (document as { exitFullscreen?: unknown }).exitFullscreen = vi.fn(() =>
      Promise.reject(new Error("nope")),
    );
    const { result } = setup();
    await act(async () => result.current.toggle());

    await act(async () => result.current.collapse());

    // Otherwise the view is stuck open with no way out.
    expect(result.current.expanded).toBe(false);
  });

  it("stays expanded via CSS when the browser refuses the request", async () => {
    (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen = vi.fn(() =>
      Promise.reject(new Error("permissions policy")),
    );
    const { result } = setup();

    await act(async () => result.current.toggle());

    expect(result.current.expanded).toBe(true);
    expect(result.current.nativeFullscreen).toBe(false);
    expect(result.current.escapeExits).toBe(true);
  });

  it("signals every transition so the caller can restore keyboard capture", async () => {
    grantFullscreen();
    const onTransition = vi.fn();
    const { result } = setup(onTransition);

    await act(async () => result.current.toggle());
    expect(onTransition).toHaveBeenCalledTimes(1);

    await act(async () => result.current.toggle());
    expect(onTransition).toHaveBeenCalledTimes(2);
  });
});
