"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Expand/collapse an element to fill the screen, preferring the browser's own Fullscreen API.
 *
 * Native fullscreen is not just the tidier option here — it is the one that resolves the Escape
 * conflict for free. The relay wizard forwards Escape to the remote browser (it is a real key a
 * login page may want), so binding Escape to "leave fullscreen" would steal it. While a document
 * is natively fullscreen the browser consumes the Escape that exits and never dispatches it to
 * the page, so both behaviours coexist without either having to give way.
 *
 * The CSS fallback covers a browser that lacks the API, refuses it, or is embedded somewhere a
 * permissions policy forbids it. There nothing intercepts Escape for us, so the caller has to —
 * see `escapeExits`.
 *
 * Every path ends in `onTransition`, including the failures. That callback is how the caller
 * restores whatever the transition disturbed — for the wizard, keyboard focus — so a path that
 * skips it leaves the feature looking broken rather than merely unstyled.
 */
export interface Expandable {
  /** The element should fill the screen, by whichever mechanism. */
  expanded: boolean;
  /** True when the browser's Fullscreen API is doing it, false when the CSS fallback is. */
  nativeFullscreen: boolean;
  /**
   * True when the caller must handle Escape itself: expanded, but with no browser fullscreen
   * intercepting the key. Lets the key handler forward Escape in every other situation.
   */
  escapeExits: boolean;
  toggle: () => void;
  collapse: () => void;
}

export function useExpandable(
  ref: { current: HTMLElement | null },
  /** Called after every transition, successful or not — the wizard restores keyboard capture. */
  onTransition?: () => void,
): Expandable {
  const [expanded, setExpanded] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  // Mirrors nativeFullscreen for the fullscreenchange listener, which must not re-subscribe on
  // every change and so cannot read the state variable.
  const nativeRef = useRef(false);

  /** The single place state settles, so no path can reach a new layout without signalling it. */
  const settle = useCallback(
    (isExpanded: boolean, isNative: boolean) => {
      nativeRef.current = isNative;
      setExpanded(isExpanded);
      setNativeFullscreen(isNative);
      onTransition?.();
    },
    [onTransition],
  );

  // The browser can leave fullscreen without us: Escape, F11, the tab going to the background.
  // Treating this event as the source of truth keeps the button label honest in those cases.
  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement || !nativeRef.current) return;
      settle(false, false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [settle]);

  const collapse = useCallback(() => {
    if (nativeRef.current && document.fullscreenElement && document.exitFullscreen) {
      // On success fullscreenchange finishes the job; if the browser refuses, settle anyway
      // rather than leaving a view that will not close.
      Promise.resolve(document.exitFullscreen()).catch(() => settle(false, false));
      return;
    }
    settle(false, false);
  }, [settle]);

  const expand = useCallback(() => {
    // Expand immediately: the CSS fallback is correct on its own, and the operator gets the
    // bigger view without waiting to hear whether the browser will grant real fullscreen.
    setExpanded(true);

    let request: Promise<void> | undefined;
    try {
      request = ref.current?.requestFullscreen?.();
    } catch {
      // A refusal can arrive as a synchronous throw rather than a rejected promise — a
      // permissions policy on an embedding frame does exactly that. Letting it escape would
      // abort this handler before `settle`, stranding the view expanded with focus still on
      // whatever was clicked, and surface as an uncaught error in the console.
      request = undefined;
    }

    if (!request) {
      settle(true, false);
      return;
    }
    Promise.resolve(request).then(
      () => settle(true, true),
      () => settle(true, false),
    );
  }, [ref, settle]);

  const toggle = useCallback(() => {
    if (expanded) collapse();
    else expand();
  }, [expanded, collapse, expand]);

  return {
    expanded,
    nativeFullscreen,
    escapeExits: expanded && !nativeFullscreen,
    toggle,
    collapse,
  };
}
