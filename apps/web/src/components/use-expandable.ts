"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Expand/collapse a element to fill the screen, preferring the browser's own Fullscreen API.
 *
 * Native fullscreen is not just the tidier option here — it is the one that resolves the Escape
 * conflict for free. The relay wizard forwards Escape to the remote browser (it is a real key a
 * login page may want), so binding Escape to "leave fullscreen" would steal it. While a document
 * is natively fullscreen the browser consumes the Escape that exits and never dispatches it to
 * the page, so both behaviours coexist without either having to give way.
 *
 * The CSS fallback exists for a browser that refuses or lacks the API. There, nothing intercepts
 * Escape on our behalf, so the caller has to — see `escapeExits`.
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
  /** Called after every transition — the wizard uses it to restore keyboard capture. */
  onTransition?: () => void,
): Expandable {
  const [expanded, setExpanded] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);

  // The browser can leave fullscreen without us: Escape, F11, the tab going to the background.
  // Treating this event as the source of truth keeps the button label honest in those cases.
  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement) return;
      setNativeFullscreen((wasNative) => {
        if (wasNative) {
          setExpanded(false);
          onTransition?.();
        }
        return false;
      });
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [onTransition]);

  const collapse = useCallback(() => {
    if (document.fullscreenElement && document.exitFullscreen) {
      // fullscreenchange finishes the job, including onTransition.
      void Promise.resolve(document.exitFullscreen()).catch(() => undefined);
      return;
    }
    setExpanded(false);
    setNativeFullscreen(false);
    onTransition?.();
  }, [onTransition]);

  const expand = useCallback(() => {
    setExpanded(true);
    const el = ref.current;
    if (!el?.requestFullscreen) {
      onTransition?.();
      return;
    }
    Promise.resolve(el.requestFullscreen()).then(
      () => {
        setNativeFullscreen(true);
        onTransition?.();
      },
      () => {
        // Refused (no user gesture, embedded in a restrictive frame, permissions policy).
        // The CSS fallback is already applied; just stay there.
        setNativeFullscreen(false);
        onTransition?.();
      },
    );
  }, [ref, onTransition]);

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
