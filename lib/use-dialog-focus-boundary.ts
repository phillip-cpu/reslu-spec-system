"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function dialogFocusWrapTarget(currentIndex: number, total: number, backwards: boolean) {
  if (total <= 0) return null;
  if (currentIndex < 0) return backwards ? total - 1 : 0;
  if (backwards && currentIndex === 0) return total - 1;
  if (!backwards && currentIndex === total - 1) return 0;
  return null;
}

function focusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)].filter((element) => (
    element.getAttribute("aria-hidden") !== "true"
    && !element.hasAttribute("disabled")
    && element.getClientRects().length > 0
  ));
}

export function useDialogFocusBoundary<T extends HTMLElement>({
  active,
  containerRef,
  onEscape,
  escapeDisabled = false,
}: {
  active: boolean;
  containerRef: RefObject<T | null>;
  onEscape?: () => void;
  escapeDisabled?: boolean;
}) {
  const onEscapeRef = useRef(onEscape);
  const escapeDisabledRef = useRef(escapeDisabled);

  useEffect(() => {
    onEscapeRef.current = onEscape;
    escapeDisabledRef.current = escapeDisabled;
  }, [escapeDisabled, onEscape]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const preferred = container.querySelector<HTMLElement>("[autofocus]");
      const first = focusableElements(container)[0];
      (preferred ?? first ?? container).focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onEscapeRef.current && !escapeDisabledRef.current) {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(container);
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const targetIndex = dialogFocusWrapTarget(currentIndex, focusable.length, event.shiftKey);
      if (targetIndex == null) return;
      event.preventDefault();
      (focusable[targetIndex] ?? container).focus({ preventScroll: true });
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [active, containerRef]);
}
