"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { ConversationWorkspace } from "@/components/conversations/ConversationWorkspace";

const STORAGE_KEY = "reslu:desktop-messenger:v1";
const DEFAULT_WIDTH = 820;
const DEFAULT_HEIGHT = 720;
const MIN_WIDTH = 520;
const MIN_HEIGHT = 460;

interface MessengerPreferences {
  open: boolean;
  minimized: boolean;
  width: number;
  height: number;
}

interface ResizeGesture {
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

function fitDimensions(width: number, height: number) {
  if (typeof window === "undefined") return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  return {
    width: Math.min(Math.max(MIN_WIDTH, width), Math.max(MIN_WIDTH, window.innerWidth - 40)),
    height: Math.min(Math.max(MIN_HEIGHT, height), Math.max(MIN_HEIGHT, window.innerHeight - 48)),
  };
}

function subscribeDesktop(listener: () => void) {
  const media = window.matchMedia("(min-width: 768px)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

function desktopSnapshot() {
  return window.matchMedia("(min-width: 768px)").matches;
}

function loadPreferences(): MessengerPreferences {
  const fallback = { open: false, minimized: false, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<MessengerPreferences> | null;
    if (!parsed || typeof parsed !== "object") return fallback;
    const dimensions = fitDimensions(Number(parsed.width) || DEFAULT_WIDTH, Number(parsed.height) || DEFAULT_HEIGHT);
    return {
      open: parsed.open === true,
      minimized: parsed.minimized === true,
      ...dimensions,
    };
  } catch {
    return fallback;
  }
}

export function GlobalMessenger() {
  const pathname = usePathname();
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => false);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [callCompact, setCallCompact] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [dimensions, setDimensions] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const resizeGestureRef = useRef<ResizeGesture | null>(null);
  const onMessagesPage = pathname.startsWith("/messages");
  const panelVisible = ready && (open || onMessagesPage);
  const panelChromeVisible = panelVisible && !callCompact;
  const workspaceInteractive = (panelChromeVisible && (!minimized || onMessagesPage)) || callActive;
  const handleCallActiveChange = useCallback((nextActive: boolean) => {
    setCallActive(nextActive);
    if (!nextActive) setCallCompact(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = loadPreferences();
      setOpen(stored.open);
      setMinimized(stored.minimized);
      setDimensions({ width: stored.width, height: stored.height });
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open, minimized, ...dimensions }));
  }, [dimensions, minimized, open, ready]);

  useEffect(() => {
    const fit = () => setDimensions((current) => fitDimensions(current.width, current.height));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: dimensions.width,
      startHeight: dimensions.height,
    };
  }

  function continueResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = resizeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setDimensions(fitDimensions(
      gesture.startWidth + gesture.startX - event.clientX,
      gesture.startHeight + gesture.startY - event.clientY,
    ));
  }

  function finishResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (resizeGestureRef.current?.pointerId !== event.pointerId) return;
    resizeGestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  if (!desktop) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setMinimized(false);
        }}
        aria-label="Open RESLU messages"
        aria-expanded={panelVisible}
        className={clsx(
          "fixed bottom-6 right-6 z-[58] flex min-h-12 items-center gap-3 rounded-full bg-nearblack px-5 py-3 text-subhead font-semibold text-white shadow-[0_18px_55px_rgba(20,18,15,0.35)]",
          (panelVisible || onMessagesPage || callActive) && "invisible pointer-events-none",
        )}
      >
        <span className="relative flex h-7 w-7 items-center justify-center" aria-hidden>
          <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 11.5a7.8 7.8 0 0 1-8 7.5 9.2 9.2 0 0 1-3.3-.6L4 20l1.5-4A7.1 7.1 0 0 1 4 11.5 7.8 7.8 0 0 1 12 4a7.8 7.8 0 0 1 8 7.5Z" />
          </svg>
          {unreadCount > 0 && <span className="absolute -right-2 -top-2 min-w-5 rounded-full bg-red-700 px-1 text-center text-[10px] leading-5 text-white">{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </span>
        Messages
      </button>

      <section
        aria-label="Persistent RESLU messenger"
        className={clsx(
          "fixed z-[60] flex flex-col overflow-hidden border border-[#cfc6b8] bg-[#f5f1e8] shadow-[0_24px_90px_rgba(20,18,15,0.38)]",
          onMessagesPage ? "inset-y-0 left-56 right-0 rounded-none border-y-0 border-r-0 shadow-none" : "bottom-5 right-5 rounded-2xl",
          !panelChromeVisible && "invisible pointer-events-none",
        )}
        style={onMessagesPage ? undefined : {
          width: dimensions.width,
          height: minimized ? 58 : dimensions.height,
          maxWidth: "calc(100vw - 2.5rem)",
          maxHeight: "calc(100vh - 2.5rem)",
        }}
      >
        <header className="relative flex h-[58px] shrink-0 items-center gap-3 border-b border-[#d4cbbd] bg-nearblack px-4 text-white">
          {!minimized && !onMessagesPage && (
            <button
              type="button"
              aria-label="Resize messenger"
              title="Drag to resize"
              onPointerDown={beginResize}
              onPointerMove={continueResize}
              onPointerUp={finishResize}
              onPointerCancel={finishResize}
              className="absolute left-0 top-0 h-5 w-5 cursor-nwse-resize touch-none rounded-br-lg border-b border-r border-white/20"
            />
          )}
          <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10">
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 11.5a7.8 7.8 0 0 1-8 7.5 9.2 9.2 0 0 1-3.3-.6L4 20l1.5-4A7.1 7.1 0 0 1 4 11.5 7.8 7.8 0 0 1 12 4a7.8 7.8 0 0 1 8 7.5Z" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-subhead font-semibold">RESLU Messages</p>
            <p className="truncate text-[10px] text-white/50">Stays open while you move through RESLU</p>
          </div>
          {!onMessagesPage && (
            <>
              <button
                type="button"
                onClick={() => setMinimized((value) => !value)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-white/70 hover:bg-white/10 hover:text-white"
                aria-label={minimized ? "Restore messenger" : "Minimise messenger"}
              >
                {minimized ? "□" : "—"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-xl text-white/70 hover:bg-white/10 hover:text-white"
                aria-label="Close messenger"
              >
                ×
              </button>
            </>
          )}
        </header>
        <div className={clsx("min-h-0 flex-1", minimized && !onMessagesPage && "invisible")}>
          <ConversationWorkspace
            presentation="drawer"
            active={workspaceInteractive}
            onCallActiveChange={handleCallActiveChange}
            callCompact={callCompact}
            onCallCompactChange={setCallCompact}
            onUnreadCountChange={setUnreadCount}
          />
        </div>
      </section>
    </>
  );
}
