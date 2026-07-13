"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * ProposalReveal — the client-side skin over `/proposal/[token]`
 * (BUILD-SPEC.md §"Proposal delivery skin (r25)" items 2-3). Server
 * component `app/proposal/[token]/page.tsx` stays the document
 * renderer (unchanged data fetch, unchanged sign/viewed_at/rate-limit
 * machinery) and now wraps its existing `<main>` in this component,
 * passed as `children` — a Server Component rendered as a Client
 * Component's `children` prop stays server-rendered (Next.js App
 * Router's documented composition pattern), so the FULL document is
 * always present in the DOM from the first response — nothing here
 * ever (re)fetches or re-renders the proposal content, it only
 * toggles visibility/opacity around it.
 *
 * ============================================================
 * The client's own core requirement, verbatim: "the page needs to be
 * the page from the website the video of the turning pages" — the
 * reveal below plays public/begin-unfold.mp4 (begin-fold.mp4,
 * reversed) as a real, filmed <video>. It is not a CSS imitation of
 * paper; CSS is only ever the FALLBACK path (no video / reduced motion
 * / small viewport / degenerate alignment).
 *
 * ============================================================
 * r25.2 "Proposal reveal — final approved choreography" (BUILD-SPEC.md
 * §"Proposal reveal — final approved choreography (r25.2)"). Phillip
 * approved docs/preview-proposal-reveal.html verbatim 2026-07-12 ("you
 * got it") — that file's layout()/write()/textOnSheet()/seal() and its
 * timeupdate handler are the reference implementation this round ports
 * EXACTLY, on the filmed path only. It SUPERSEDES both r25's original
 * packet-box video geometry (computeUnfoldGeometry(), clip-path +
 * HALO-padded feather union, matching the video to the packet's own
 * live rect) and r25.1's on-sheet landing-layer handoff
 * (mountLanding()/crossfadeToDocumentLanded()/.pr-landing) — all of
 * that machinery is gone; see docs/API.md's r25.1 section for the
 * superseded approach's own writeup and this round's note for why.
 *
 * What's copied verbatim from the preview (see computeSheetGeometry()
 * and playVideoFold() below for the ported maths, and see this file's
 * git history / docs/API.md for the exact mapping):
 *   - layout(): the video wrapper is sized from the TARGET READING
 *     COLUMN width, not the packet's own on-screen box — sheetW =
 *     min(520px, 86vw), videoWidth = sheetW/(FV.sx1-FV.sx0), the
 *     wrapper "sits slightly high" via a 0.6-of-available-space top
 *     offset, and the in-flow document's own width/marginTop are
 *     derived from that SAME geometry so it renders exactly on the
 *     filmed sheet's on-screen box — no separate landing layer, no
 *     ease-to-position, the text simply never moves (BUILD-SPEC item
 *     1). Recomputed on resize while the filmed phase is live (item
 *     6), same as the preview's own unconditional resize listener.
 *   - the front ink+date overlay does not pre-fade; its opacity is
 *     driven directly off the film's own clock in the `timeupdate`
 *     handler (WIPE_START/WIPE_END, item 2) instead of a CSS
 *     transition snapping it to 0 the instant the video phase starts.
 *   - the proposal document fades in (opacity-only, ~1.1s ease) at
 *     duration−DOC_FADE_LEAD, and the film/overlay seals (fades out,
 *     scroll unlocks) at duration−SEAL_LEAD, with `ended` as a safety
 *     net for both (items 3-4).
 *   - the feather gradient's stops (item 5) — now static (percentage-
 *     based, independent of pixel geometry), so it lives directly in
 *     app/globals.css instead of being computed at runtime.
 *
 * TECHNIQUES STILL COPIED (verbatim-adapted) FROM reslu-site's
 * src/components/BeginForm.astro, unaffected by r25.2 — read in full
 * for r25, per docs/RESLU-Paper-Animation-Brief.md:
 *   - write(el, text, done) — the char-by-char pen, 36ms/interval,
 *     caret span, 350ms lift pause before `done()`. Copied near-
 *     verbatim as writeInto() below (React can't use Astro's
 *     `<style is:global>`, but the exact same JS-created-DOM-node
 *     problem applies — see app/globals.css's own header comment on
 *     why the CSS lives there, not in a scoped/CSS-module file).
 *   - .sheet cardstock recipe (#faf6ec / #e6dfcf / grain SVG) — reused
 *     as .pr-packet in app/globals.css. IMPORTANT (r25.2 seam fix,
 *     below): .pr-packet is the CSS-fallback (cssfold) path's ONLY
 *     "closed packet" visual now — the filmed path never renders it.
 *   - The emboss mask recipe (#e2dac5 fill masked by the real logo
 *     PNG, lit with 3 drop-shadows) — .pr-emboss (cssfold path only,
 *     same reason as above).
 *   - prefers-reduced-motion handling, and the "readyState >= 3, else
 *     race canplaythrough against a timeout, else fall back" video-
 *     readiness pattern.
 *
 * ============================================================
 * r25.2 seam fix — "the filmed path's beat 1 IS the film" (BUILD-SPEC.md
 * §"Proposal reveal — beat 1/2 seam fix"). r25.2 above ported the
 * preview's choreography honestly but left one seam the preview itself
 * doesn't have: beat 1 showed the small, overlay-centred CSS `.pr-packet`
 * mockup for EVERY visitor (video-bound or not), then, only once the
 * filmed path was chosen, playVideoFold() resized that same element to
 * computeSheetGeometry()'s (larger, higher-sitting) box — a visible
 * size/position jump the preview never has, because the preview's own
 * `<video>` IS the packet from `play()`'s very first frame (`film.pause();
 * film.currentTime=0;`, then the pen writes ON that paused frame). This
 * round closes that gap on the filmed path ONLY:
 *   - `.pr-packet` (the CSS mockup) is now rendered ONLY while the
 *     cssfold fallback is the live/chosen path (JSX gates it on
 *     `!videoOn`) — the filmed path never mounts it, at any phase.
 *   - The video's own wrapper (`.pr-vwrap`, `filmWrapRef`) is what
 *     `applySheetGeometry()` now sizes — a separate element from
 *     `.pr-packet`, with none of its cardstock chrome (no settle-in
 *     animation, no aspect-ratio default) — mounted for the WHOLE
 *     overlay lifetime (from `phase === "checking"` onward) purely so
 *     the `<video>` inside it can preload without ever needing to
 *     unmount/remount. `playVideoFold()` pauses it at `currentTime = 0`
 *     and applies computeSheetGeometry() BEFORE anything else happens on
 *     the filmed path — that paused first frame is the resting packet
 *     from the first paint of beat 2, at its FINAL beat-2 size.
 *   - The ink+date overlay for the filmed path is a new, separate
 *     element (`.pr-film-overlay`, `frontRef`/`filmNameRef`) rather than
 *     the cssfold packet's `.pr-packet-front` (which carries the emboss
 *     + "Design Proposal" label the filmed path never showed anyway) —
 *     positioned exactly like the preview's own `.overlay` (`top: 50%`
 *     of the video wrapper, `translateY(-50%)`, centred text).
 *   - The readiness decision (`decideAndPlayBeat2()`) now runs BEFORE
 *     any packet visual renders — beat 1 opens on a brief, neutral bone
 *     `.pr-overlay` background only (the "checking" phase) — and the pen
 *     writes AFTER the path is chosen, on whichever packet visual that
 *     path actually uses: the film's paused first frame (filmed path,
 *     inside playVideoFold(), ported from the preview's own
 *     `write(ink, name, function(){ setTimeout(...play,250); })`) or the
 *     CSS mockup (cssfold path, inside playCssFold(), same dwell-then-go
 *     shape r25.2 already used). Neither path shows the OTHER path's
 *     packet visual at any point.
 *   - Making "checking" a genuinely visible (overlay-mounted) phase
 *     introduced a hazard the pre-fix code didn't have: `phase`'s
 *     initial value IS "checking" too, so a no-JS/pre-hydration render
 *     would otherwise mount the same full-screen overlay PERMANENTLY
 *     over the already-visible document (`docIn` defaults `true`
 *     precisely so that never happens — see its own comment). New
 *     `running` state (only ever flipped by runFull(), a client-only
 *     function) keeps that guarantee: `overlayMounted` requires
 *     `running`, so SSR/no-JS output is unaffected — see `running`'s own
 *     comment.
 * ============================================================
 */

/** Video-frame fractions of public/begin-unfold.mp4 (== BeginForm's own
 * FV — same footage, just played in reverse, so the same measured
 * fractions apply unchanged). The flat sheet's bounds only — r25.2's
 * column-driven geometry (see computeSheetGeometry()) never needs the
 * packet's own start-frame fractions the way r25's computeUnfoldGeometry()
 * did, so those (formerly px0/px1/py0/py1) are gone; matches the
 * preview's own `FV` const exactly (docs/preview-proposal-reveal.html). */
const FV = { sx0: 0.332, sx1: 0.67, sy0: 0.108, sy1: 0.886 };

/** Native master frame is 1280x720 (see docs/RESLU-Paper-Animation-Brief.md) —
 * the video wrapper's height is always derived from its own computed
 * width at this aspect ratio, exactly like the preview's `vh=vw*720/1280`. */
const VIDEO_ASPECT_H_OVER_W = 720 / 1280;

/** BUILD-SPEC r25.2 item 1: "the filmed sheet's width (FV sx span)
 * equals the document column (~520px, 86vw cap)" — the spec's own
 * parenthetical settles the "check and reconcile" instruction: the
 * reveal's reading column is THIS value, not the page's general
 * `main.max-w-2xl` (672px) container. `.pr-doc`'s inline width (set
 * only on the filmed path, in applySheetGeometry() below) narrows the
 * real document to match — exactly what the approved preview does
 * (its own `.doc` never returns to a wider layout after the reveal;
 * "the preview keeps the column width after reveal", so this doesn't
 * release back to `max-w-2xl` either). Fallback paths never touch
 * `.pr-doc`'s inline style at all, so `main`'s own `max-w-2xl` class
 * governs untouched there (item 6). */
const COLUMN_MAX_PX = 520;
const COLUMN_VIEWPORT_RATIO = 0.86;

/** The preview's own "sit slightly high" constant — the wrapper's top
 * offset is 0.6 of the space that would otherwise centre it, floored
 * at 8px, mirrored verbatim from layout(). */
const TOP_LIFT_RATIO = 0.6;
const TOP_MIN_PX = 8;
/** The ~14px gap layout() adds past the sheet's own top fraction
 * (FV.sy0) before the in-flow document begins. */
const DOC_TOP_GAP_PX = 14;

/** BUILD-SPEC r25.2 item 2 — front ink+date overlay opacity is driven
 * directly off the film's clock between these two timestamps (seconds
 * into playback), not a CSS transition. */
const WIPE_START = 0.9;
const WIPE_END = 1.7;
/** BUILD-SPEC r25.2 item 3 — the proposal document starts its opacity
 * fade-in this many seconds before the film's own duration. */
const DOC_FADE_LEAD = 1.4;
/** BUILD-SPEC r25.2 item 4 — the film/overlay seals (fades out, scroll
 * unlocks) this many seconds before the film's own duration (and, as a
 * safety net, on the video's `ended` event regardless of this math). */
const SEAL_LEAD = 0.1;
/** BUILD-SPEC r25.2 item 4 — "overlay/video fade ~0.6s" — matches the
 * preview's own `setTimeout(..., 650)` (its CSS transition is .6s,
 * this is that plus a small buffer before the stage unmounts), and the
 * existing (untouched) fallback crossfadeToDocument()'s own budget. */
const SEAL_TEARDOWN_MS = 650;

/** r25.2 seam-fix constants — the readiness decision (which packet visual
 * gets used at all) now happens BEFORE either path's pen writes, so the
 * old "write, then dwell, then decide" budget is replaced by a plain
 * "settle, then decide" one. CHECKING_SETTLE_MS + CHECKING_BUDGET_MS
 * still add up to the brief's own "~2.5s" figure for how long the video
 * gets to prove itself ready before falling back to cssfold. */
const CHECKING_SETTLE_MS = 350;
const CHECKING_BUDGET_MS = 2150;
/** Ports the preview's own `write(ink, name, function(){ setTimeout(
 * function(){ film.play(); }, 250); })` — the dwell between the pen
 * lifting off the paused first frame and the film starting to play. */
const FILM_PLAY_DWELL_MS = 250;
/** The cssfold path's own pen-lifts-then-go dwell, before the flap
 * starts sweeping open (playCssFold() below) — same figure r25.2 used
 * for its old (now removed) pre-decision write-then-dwell step. */
const CSS_PACKET_DWELL_MS = 500;

const SESSION_KEY_PREFIX = "reslu_proposal_reveal_";

type Phase = "checking" | "packet" | "video" | "cssfold" | "crossfade" | "finished" | "static" | "off";

/** r25.2 sheet-as-column geometry — ports the preview's layout()
 * verbatim (see this file's header comment). Both the video wrapper
 * (sized off `vw`/`vh`, positioned `top` px down) and the in-flow
 * document (`docWidth`/`docMarginTop`) are derived from the SAME
 * numbers, so the document renders exactly on the filmed sheet's
 * on-screen box with no separate measurement/landing step. */
interface SheetGeometry {
  vw: number;
  vh: number;
  top: number;
  docWidth: number;
  docMarginTop: number;
}

/** Ports the preview's `layout()` exactly: `sheetW=min(520,innerWidth*0.86)`,
 * `vw=sheetW/(FV.sx1-FV.sx0)`, `vh=vw*720/1280`, `top=max(8,(innerHeight-vh)/2*0.6)`,
 * `doc.marginTop=top+vh*FV.sy0+14`. Returns null on a degenerate viewport
 * (caller falls back to the CSS unfold, same guard shape as r25's own
 * computeUnfoldGeometry() had). */
function computeSheetGeometry(viewportW: number, viewportH: number): SheetGeometry | null {
  if (!Number.isFinite(viewportW) || !Number.isFinite(viewportH) || viewportW <= 0 || viewportH <= 0) return null;
  const colWidth = Math.min(COLUMN_MAX_PX, viewportW * COLUMN_VIEWPORT_RATIO);
  const vw = colWidth / (FV.sx1 - FV.sx0);
  const vh = vw * VIDEO_ASPECT_H_OVER_W;
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return null;
  const top = Math.max(TOP_MIN_PX, ((viewportH - vh) / 2) * TOP_LIFT_RATIO);
  const docMarginTop = top + vh * FV.sy0 + DOC_TOP_GAP_PX;
  return { vw, vh, top, docWidth: colWidth, docMarginTop };
}

/** BeginForm's own write() — copied near-verbatim (36ms/char, caret
 * span, 350ms lift pause). `active` lets the effect that calls this
 * bail out cleanly if the component unmounts mid-write. */
function writeInto(el: HTMLElement, text: string, active: { current: boolean }, done?: () => void) {
  el.innerHTML = "";
  const caret = document.createElement("span");
  caret.className = "pr-caret";
  el.append(caret);
  let i = 0;
  const t = setInterval(() => {
    if (!active.current) {
      clearInterval(t);
      return;
    }
    if (i < text.length) {
      caret.insertAdjacentText("beforebegin", text[i++]);
    } else {
      clearInterval(t);
      setTimeout(() => {
        if (!active.current) return;
        caret.remove();
        done && done();
      }, 350);
    }
  }, 36);
}

/** SSR-safe layout effect — useLayoutEffect on the client (runs before
 * paint, minimising the flash between "document only" and "overlay
 * mounted"), useEffect (a no-op-with-warning-suppressed shape) on the
 * server, where this component never actually executes render logic
 * anyway (Next.js just needs the identifier to exist during the SSR
 * pass of this "use client" module). */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function ProposalReveal({
  token,
  greetingName,
  sentDateLabel,
  residence,
  children,
}: {
  token: string;
  greetingName: string;
  sentDateLabel: string;
  residence: string;
  children: React.ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  // r25.2 seam fix — `phase`'s initial value ("checking") is ALSO its
  // pristine pre-JS/SSR value, and now that "checking" is a genuinely
  // visible, overlay-mounted state (the neutral bone screen), the two
  // need to be told apart: `running` only ever flips true inside
  // runFull(), which only ever runs on the client, inside the
  // useIsoLayoutEffect below — so a no-JS/pre-hydration render (where
  // `phase` is still its SSR-initial "checking") never mounts the
  // overlay, preserving this file's own "never hides the document
  // before JS decides to animate" guarantee (see `docIn`'s own comment).
  const [running, setRunning] = useState(false);
  const [showStatic, setShowStatic] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [overlayOut, setOverlayOut] = useState(false);
  const [docIn, setDocIn] = useState(true); // default true: never hides the document before JS decides to animate
  // r25.2 — true once THIS play-through has entered the filmed video
  // path (set alongside setPhase("video") in playVideoFold(), reset by
  // runFull()/handleReplay()). Gates `.pr-doc`'s `.pr-landed` modifier
  // (app/globals.css) — opacity-only ~1.1s fade, no translateY — which
  // is now simply "the filmed path's own fade", not a landing-layer
  // handoff (BUILD-SPEC r25.2 item 3; r25.1's on-sheet landing layer
  // and its ease-to-#pr-doc-anchor handoff are gone — see this file's
  // header comment). Fallback paths (cssfold/reduced-motion/skip) never
  // set this, so .pr-doc's original .pr-pre/.pr-in translateY(24px)
  // fade stays byte-for-byte unchanged there (item 6).
  const [sheetLanded, setSheetLanded] = useState(false);
  // Bumped every runFull() call (including a mid-animation Replay click)
  // and used as the <video>'s React `key` — forces a clean remount
  // rather than reusing the same persisted node, so a replay triggered
  // WHILE the video is already playing can never leave the previous
  // playVideoFold() call's "ended"/"timeupdate" listeners attached
  // alongside a fresh set on the same element.
  const [videoKey, setVideoKey] = useState(0);

  // The CSS-fallback (cssfold) path's own "closed packet" mockup — r25.2
  // seam fix: the filmed path never renders this element at all, see
  // this file's own header comment.
  const packetRef = useRef<HTMLDivElement | null>(null);
  // The cssfold packet's pen-name target (inside packetRef's own
  // `.pr-packet-front`).
  const nameRef = useRef<HTMLParagraphElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cssFlapRef = useRef<HTMLDivElement | null>(null);
  const cssSheetRef = useRef<HTMLDivElement | null>(null);
  // r25.2 seam fix — the FILMED path's own video wrapper (`.pr-vwrap`),
  // a plain, chrome-free element separate from `.pr-packet` — mounted
  // for the whole overlay lifetime (from `phase === "checking"` onward)
  // so the <video> inside it can preload without unmounting, and sized/
  // positioned by applySheetGeometry() the instant the filmed path is
  // chosen (BEFORE the pen writes or the video plays).
  const filmWrapRef = useRef<HTMLDivElement | null>(null);
  // r25.2 seam fix — the filmed path's own ink+date overlay (`.pr-film-
  // overlay`), positioned over the video wrapper like the approved
  // preview's own `.overlay` (top:50%, translateY(-50%), centred) —
  // separate from the cssfold packet's `.pr-packet-front` (which also
  // carries the emboss/label the filmed path never showed). Its opacity
  // is driven as ONE clock-driven value by playVideoFold()'s timeupdate
  // handler (WIPE_START/WIPE_END), exactly as the old frontRef did.
  const frontRef = useRef<HTMLDivElement | null>(null);
  // The filmed overlay's pen-name target (inside frontRef's element).
  const filmNameRef = useRef<HTMLParagraphElement | null>(null);
  // r25.2 — the in-flow document wrapper; playVideoFold()'s
  // applySheetGeometry() sets its width/margin directly (see
  // computeSheetGeometry()'s own comment for why the filmed path never
  // releases this back to `main`'s own `max-w-2xl`).
  const docRef = useRef<HTMLDivElement | null>(null);
  // r25.2 — the filmed phase's resize listener teardown (BUILD-SPEC
  // item 6: "recompute layout on resize... scoped to the filmed
  // phase"); null when no such listener is attached.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const bodyOverflowRef = useRef<string | null>(null);

  const sessionKey = `${SESSION_KEY_PREFIX}${token}`;

  function schedule(fn: () => void, ms: number) {
    const id = setTimeout(() => {
      if (alive.current) fn();
    }, ms);
    timers.current.push(id);
    return id;
  }

  function clearTimers() {
    timers.current.forEach((id) => clearTimeout(id));
    timers.current = [];
  }

  function lockScroll() {
    try {
      bodyOverflowRef.current = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    } catch {
      /* ignore */
    }
  }

  function unlockScroll() {
    try {
      document.body.style.overflow = bodyOverflowRef.current ?? "";
    } catch {
      /* ignore */
    }
  }

  function markSeen() {
    try {
      sessionStorage.setItem(sessionKey, "1");
    } catch {
      /* private mode / blocked storage — never fatal, just replays next time */
    }
  }

  function hasSeen(): boolean {
    try {
      return sessionStorage.getItem(sessionKey) === "1";
    } catch {
      return false;
    }
  }

  function reducedMotion(): boolean {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  function tooNarrow(): boolean {
    try {
      return window.innerWidth < 480;
    } catch {
      return false;
    }
  }

  /** beat 3 (fallback paths only, r25.2 item 1/6) — cross-fade the
   * overlay out and the document in via .pr-doc's ORIGINAL .pr-pre/
   * .pr-in translateY(24px) pair, then tear the overlay down entirely
   * and unlock scroll/mark the session seen. Byte-for-byte unchanged
   * from before r25.2 — the filmed path no longer calls this at all
   * (see sealFilmed() inside playVideoFold() below), only
   * playCssFold() does. */
  function crossfadeToDocument() {
    if (!alive.current) return;
    setPhase("crossfade");
    setOverlayOut(true);
    setDocIn(true);
    markSeen();
    schedule(() => {
      unlockScroll();
      setPhase("finished");
    }, SEAL_TEARDOWN_MS);
  }

  /** r25.2 item 1 (seam-fixed) — applies computeSheetGeometry()'s numbers
   * directly as inline styles, exactly mirroring the preview's own
   * layout(): the FILMED video wrapper (filmWrapRef — `.pr-vwrap`, never
   * `.pr-packet`; see this file's header comment) gets `width`/`height`
   * set to `vw`/`vh` and is pulled out of the overlay's flex-centering
   * via `alignSelf:"flex-start"` + `marginTop:top`, and `.pr-doc` gets
   * `width:docWidth` (centred) + `marginTop:docMarginTop` so the in-flow
   * document renders exactly on the filmed sheet's on-screen box — no
   * landing layer, no ease, the text is simply already there.
   * Deliberately never released back to `main`'s own `max-w-2xl`
   * afterwards (see COLUMN_MAX_PX's own comment). Only ever called from
   * playVideoFold() (initial call + its own resize listener) — the
   * cssfold path never calls this. */
  function applySheetGeometry(geo: SheetGeometry) {
    const wrap = filmWrapRef.current;
    if (wrap) {
      wrap.style.width = `${geo.vw}px`;
      wrap.style.height = `${geo.vh}px`;
      wrap.style.alignSelf = "flex-start";
      wrap.style.marginTop = `${geo.top}px`;
    }
    const doc = docRef.current;
    if (doc) {
      doc.style.width = `${geo.docWidth}px`;
      doc.style.marginLeft = "auto";
      doc.style.marginRight = "auto";
      doc.style.marginTop = `${geo.docMarginTop}px`;
    }
  }

  /** Tears down the filmed phase's resize listener (BUILD-SPEC r25.2
   * item 6) — called once sealing completes, on replay, and on unmount. */
  function stopFilmedResize() {
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = null;
  }

  /** beat 1 (CSS fallback, r25.2 seam fix) — the CSS `.pr-packet` mockup
   * is what this path's own packet visual IS (the filmed path never
   * renders it — see this file's header comment), so it's what the pen
   * writes on. Shows the packet (`.pr-settle` fade-in, unchanged CSS),
   * writes the client's first name(s) into it, dwells, then hands off to
   * startCssFoldAnimation() below for the actual flap sweep. */
  function playCssFold() {
    if (!alive.current) return;
    setPhase("packet");
    const nameEl = nameRef.current;
    const goToFold = () => schedule(startCssFoldAnimation, CSS_PACKET_DWELL_MS);
    if (nameEl) writeInto(nameEl, greetingName, alive, goToFold);
    else goToFold();
  }

  /** beat 2 (CSS fallback) — reverse of BeginForm's own cssFold(): a
   * flap sweeps back OPEN off the packet (rotateX -180deg -> 0) while a
   * plain sheet fades in underneath, instead of a flap sweeping DOWN
   * onto a written sheet to make a packet. Unchanged by r25.2 (item 6)
   * — still adds "pr-cssfold-active" (alongside the existing
   * "pr-folding") so app/globals.css's own opacity:0!important rule for
   * the packet's front face applies HERE only, never on the filmed
   * path (which has no equivalent rule to begin with — see
   * playVideoFold()'s own front-opacity handling below). */
  function startCssFoldAnimation() {
    if (!alive.current) return;
    setPhase("cssfold");
    const packet = packetRef.current;
    packet?.classList.add("pr-folding", "pr-cssfold-active");
    schedule(() => {
      cssFlapRef.current?.classList.add("pr-go");
      cssSheetRef.current?.classList.add("pr-on");
    }, 120);
    schedule(() => crossfadeToDocument(), 1300);
  }

  /** beat 1+2 (filmed) — r25.2 seam fix: the film's own paused first
   * frame IS the resting packet, at its FINAL beat-2 size, from the
   * first paint of the filmed path (no `.pr-packet` CSS mockup ever
   * renders here — see this file's header comment). Sizes/positions the
   * video wrapper and the in-flow document from computeSheetGeometry()
   * (BUILD-SPEC item 1) and pauses the video at `currentTime = 0`
   * BEFORE anything else, then ports the preview's own `play()` pen
   * sequence: ink+date overlay visible immediately, pen writes the
   * client's first name(s), a short dwell, THEN the video plays — at
   * which point the rest of the choreography drives directly off the
   * video's own clock in a single `timeupdate` handler, exactly like
   * the approved preview (docs/preview-proposal-reveal.html):
   *   - the overlay (ink+date) is wiped out between WIPE_START/WIPE_END
   *     (item 2)
   *   - the proposal document fades in (opacity-only) at
   *     duration-DOC_FADE_LEAD (item 3)
   *   - the film seals (fades out, scroll unlocks) at duration-SEAL_LEAD,
   *     with `ended` as a safety net for both (item 4)
   * A degenerate viewport or sub-480px width falls back to the CSS
   * unfold, same guard shape r25 always had. */
  function playVideoFold() {
    const wrap = filmWrapRef.current;
    const video = videoRef.current;
    if (!wrap || !video) {
      playCssFold();
      return;
    }
    const geo = computeSheetGeometry(window.innerWidth, window.innerHeight);
    if (!geo || tooNarrow()) {
      playCssFold();
      return;
    }

    applySheetGeometry(geo);
    setPhase("video");
    setVideoOn(true);

    // The paused first frame IS the resting packet — no play() yet, the
    // pen writes on this frame first (ported from the preview's own
    // `play()`: `film.pause(); film.currentTime = 0;` before `write()`).
    video.pause();
    video.currentTime = 0;

    // Overlay (ink+date) starts visible — never pre-fades (BUILD-SPEC
    // item 2; ports the preview's own `overlay.style.opacity='1'`).
    const front = frontRef.current;
    if (front) {
      front.style.transition = "none";
      front.style.opacity = "1";
    }

    let docFaded = false;
    let sealedFlag = false;

    /** duration-DOC_FADE_LEAD trigger — ports the preview's textOnSheet()
     * verbatim: .pr-doc gets the opacity-only .pr-landed fade (no
     * translateY — the text is already positioned correctly by
     * applySheetGeometry() above) and the session is marked seen. */
    const showDoc = () => {
      if (docFaded || !alive.current) return;
      docFaded = true;
      setSheetLanded(true);
      setDocIn(true);
      markSeen();
    };

    /** duration-SEAL_LEAD trigger (+ `ended` safety net) — ports the
     * preview's seal() verbatim: the overlay fades out and scroll
     * unlocks IMMEDIATELY (not after the fade completes — the preview's
     * own seal() calls `body.classList.remove('locked')` synchronously,
     * only the stage's `display:none` teardown is deferred), then the
     * overlay is torn down after SEAL_TEARDOWN_MS once its own fade has
     * resolved. */
    const sealFilmed = () => {
      if (sealedFlag || !alive.current) return;
      sealedFlag = true;
      showDoc(); // safety: guarantees the doc is visible even if `ended` fires early
      setPhase("crossfade");
      setOverlayOut(true);
      unlockScroll();
      stopFilmedResize();
      schedule(() => setPhase("finished"), SEAL_TEARDOWN_MS);
    };

    const onTimeUpdate = () => {
      if (!video.duration) return;
      const t = video.currentTime;
      const f = frontRef.current;
      if (f) {
        if (t <= WIPE_START) f.style.opacity = "1";
        else if (t >= WIPE_END) f.style.opacity = "0";
        else f.style.opacity = String(1 - (t - WIPE_START) / (WIPE_END - WIPE_START));
      }
      if (t > video.duration - DOC_FADE_LEAD) showDoc();
      if (t > video.duration - SEAL_LEAD) sealFilmed();
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener(
      "ended",
      () => {
        showDoc();
        sealFilmed();
      },
      { once: true }
    );

    // Recompute geometry on resize while the filmed phase is live
    // (BUILD-SPEC item 6 — "mirror the preview's resize listener scoped
    // to the filmed phase"; the preview's own `layout()` listener is
    // unconditional/global since it has no other phases to avoid). Live
    // from the paused first frame onward, not just once playback starts,
    // so a resize mid-write still keeps the packet correctly placed.
    const onResize = () => {
      const g = computeSheetGeometry(window.innerWidth, window.innerHeight);
      if (g) applySheetGeometry(g);
    };
    window.addEventListener("resize", onResize);
    resizeCleanupRef.current = () => window.removeEventListener("resize", onResize);

    /** Pen writes → FILM_PLAY_DWELL_MS dwell → video.play() — ports the
     * preview's own `write(ink, name, function(){ setTimeout(function(){
     * film.play(); }, 250); })` verbatim. Everything above (timeupdate/
     * ended/resize listeners) is already attached, same as before this
     * round's restructure — only WHEN playback starts moved. */
    const beginPlayback = () => {
      if (!alive.current) return;
      video.play().catch(() => {
        // Autoplay blocked (rare for a muted video, but not impossible) —
        // fall back rather than stall on a frozen, silently-written packet.
        setVideoOn(false);
        stopFilmedResize();
        if (front) {
          front.style.opacity = "0";
          front.style.transition = "";
        }
        playCssFold();
      });
    };
    const nameEl = filmNameRef.current;
    if (nameEl) writeInto(nameEl, greetingName, alive, () => schedule(beginPlayback, FILM_PLAY_DWELL_MS));
    else schedule(beginPlayback, FILM_PLAY_DWELL_MS);
  }

  /** beat 1 -> beat 2 handoff: give the video up to ~2.5s total (from
   * mount) to reach readyState >= 3, otherwise fall back to CSS —
   * mirrors BeginForm's own readyState-then-canplaythrough-then-timeout
   * race in its `finish()`. */
  function decideAndPlayBeat2(deadlineMs: number) {
    if (!alive.current) return;
    if (tooNarrow()) {
      playCssFold();
      return;
    }
    const video = videoRef.current;
    if (!video) {
      playCssFold();
      return;
    }
    if (video.readyState >= 3) {
      playVideoFold();
      return;
    }
    let settled = false;
    const go = (fn: () => void) => {
      if (settled || !alive.current) return;
      settled = true;
      fn();
    };
    video.addEventListener("canplaythrough", () => go(playVideoFold), { once: true });
    schedule(() => go(playCssFold), Math.max(0, deadlineMs));
  }

  /** beat 1 (r25.2 seam fix) — opens on a brief, neutral bone `.pr-overlay`
   * background only ("checking" phase: no `.pr-packet` mockup, no video-
   * sized wrapper visible, no pen writing yet) while the video quietly
   * preloads, THEN decides the path. The pen only ever writes AFTER that
   * decision, inside whichever of playVideoFold()/playCssFold() the path
   * turns out to be — see this file's header comment. */
  function runFull() {
    if (!alive.current) return;
    setRunning(true);
    setVideoKey((k) => k + 1);
    setPhase("checking");
    setOverlayOut(false);
    setDocIn(false);
    setSheetLanded(false);
    setVideoOn(false);
    lockScroll();
    // The <video> itself mounts (see JSX below) as soon as `phase` is
    // "checking" — a dedicated effect keyed on `phase` calls load() the
    // instant it exists, so it has this whole settle-then-decide window
    // to reach canplaythrough before decideAndPlayBeat2() needs an
    // answer (see the `useEffect` below this function).
    schedule(() => decideAndPlayBeat2(CHECKING_BUDGET_MS), CHECKING_SETTLE_MS);
  }

  function decideMode(force?: "replay") {
    if (force !== "replay" && hasSeen()) {
      setPhase("static");
      setShowStatic(true);
      return;
    }
    if (reducedMotion()) {
      setPhase("static");
      setShowStatic(true);
      markSeen();
      return;
    }
    runFull();
  }

  // Runs once, before paint, so the SSR "document only, no overlay"
  // frame and the client's real decision are as close together as
  // possible (see this file's own header comment + useIsoLayoutEffect).
  useIsoLayoutEffect(() => {
    alive.current = true;
    decideMode();
    return () => {
      alive.current = false;
      clearTimers();
      stopFilmedResize();
      unlockScroll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The <video> element (see JSX below) mounts once and stays mounted for
  // the checking/packet/video/cssfold/crossfade phases — it must NOT
  // unmount/remount between beat 1 (preload, starting at "checking" —
  // r25.2 seam fix moved this earlier than "packet" so preloading starts
  // the instant runFull() opens the neutral bone screen) and beat 2
  // (play), or the whole point of preloading during beat 1 is lost. This
  // effect just kicks off the load() the instant the node exists. Keyed
  // on `[running, phase]`, not just `[phase]` — the very first runFull()
  // call sets `phase` to "checking" AGAIN (it's already the SSR-initial
  // value), so `phase` alone doesn't change on that first transition;
  // `running` (false -> true) is what actually flips, so it has to be a
  // dependency too or this first load() call would never fire.
  useEffect(() => {
    if (running && phase === "checking") {
      try {
        videoRef.current?.load();
      } catch {
        /* ignore */
      }
    }
  }, [running, phase]);

  function handleReplay() {
    clearTimers();
    stopFilmedResize();
    setOverlayOut(false);
    setShowStatic(false);
    setVideoOn(false);
    setSheetLanded(false);
    cssFlapRef.current?.classList.remove("pr-go");
    cssSheetRef.current?.classList.remove("pr-on");
    if (packetRef.current) {
      // Clear the fold-state classes from a previous cssfold run, so the
      // next playCssFold() starts from the same clean CSS-only packet a
      // first-time visitor sees.
      packetRef.current.classList.remove("pr-folding", "pr-cssfold-active");
    }
    if (filmWrapRef.current) {
      // Clear any inline geometry left over from a mid-flight filmed
      // play-through (applySheetGeometry()), so the next playVideoFold()
      // call starts from a clean, ungeometried wrapper.
      filmWrapRef.current.style.width = "";
      filmWrapRef.current.style.height = "";
      filmWrapRef.current.style.alignSelf = "";
      filmWrapRef.current.style.marginTop = "";
    }
    if (frontRef.current) {
      frontRef.current.style.opacity = "";
      frontRef.current.style.transition = "";
    }
    if (docRef.current) {
      docRef.current.style.width = "";
      docRef.current.style.marginLeft = "";
      docRef.current.style.marginRight = "";
      docRef.current.style.marginTop = "";
    }
    decideMode("replay");
  }

  // r25.2 seam fix — "checking" joins this list (the overlay — neutral
  // bone background, see runFull()'s own comment — mounts as soon as the
  // reveal starts, not only once a packet visual is ready to show, so
  // the <video> can begin preloading immediately), gated on `running` so
  // a no-JS/pre-hydration render (phase still its SSR-initial "checking"
  // but `running` still false) never mounts it — see `running`'s own
  // comment. The other four phases were always only reachable via
  // runFull()'s own downstream calls anyway, so gating them on `running`
  // too changes nothing for them, just makes the invariant explicit.
  const overlayMounted =
    running &&
    (phase === "checking" || phase === "packet" || phase === "video" || phase === "cssfold" || phase === "crossfade");

  return (
    <>
      {/* Always server-rendered, identical on server + client — the
       * permanent "quiet replay" control (BUILD-SPEC item 3), plus (once
       * the client has decided a skip applies) the static packet summary
       * a returning / reduced-motion / no-video visitor gets instead of
       * the filmed reveal. */}
      <div className="pr-strip mx-auto max-w-2xl px-6 pt-4">
        {showStatic && (
          <div className="pr-strip-static">
            <span className="label-caps">Design Proposal</span>
            <span className="pr-ink">{greetingName}</span>
            <span className="pr-strip-date">
              {residence} &middot; {sentDateLabel}
            </span>
          </div>
        )}
        <button type="button" className="pr-replay" onClick={handleReplay}>
          Replay
        </button>
      </div>

      {overlayMounted && (
        <div className={`pr-overlay${overlayOut ? " pr-out" : ""}`} aria-hidden="true">
          {/* r25.2 seam fix — the CSS "closed packet" mockup is now the
           * cssfold FALLBACK path's own visual ONLY: it renders while
           * that path is choosing/writing/animating (`phase === "packet"`
           * i.e. playCssFold()'s pen-write step, or `"cssfold"` i.e. the
           * flap sweep) and stays mounted through the shared `"crossfade"`
           * phase so it fades out WITH `.pr-overlay` — but `!videoOn`
           * guards all of that: the instant the filmed path is chosen,
           * `videoOn` flips true and this element never renders again for
           * the rest of that play-through, even during "crossfade"/
           * "finished". See this file's header comment. */}
          {!videoOn && (phase === "packet" || phase === "cssfold" || phase === "crossfade") && (
            <div className="pr-packet" ref={packetRef}>
              <div className="pr-packet-front">
                <div className={`pr-emboss${phase === "packet" ? " pr-show" : ""}`} />
                <p className="label-caps pr-label">Design Proposal</p>
                <p className="pr-ink pr-name" ref={nameRef} />
                <p className="pr-cap">
                  {residence} &middot; {sentDateLabel}
                </p>
              </div>
              {phase === "cssfold" && (
                <>
                  <div className="pr-csssheet" ref={cssSheetRef} />
                  <div className="pr-cssflap" ref={cssFlapRef} />
                </>
              )}
            </div>
          )}

          {/* r25.2 seam fix — the FILMED path's own wrapper (`.pr-vwrap`,
           * never `.pr-packet`): mounted for the whole overlay lifetime
           * (from "checking" onward) so the <video> inside it can preload
           * without ever unmounting/remounting (same requirement r25.2
           * always had, just starting one phase earlier now). Sized/
           * positioned by applySheetGeometry() the instant the filmed
           * path is chosen — the video simply fills it (100%/100%) at the
           * wrapper's own vw:vh aspect ratio; `.pr-vfeather` blends its
           * edges into the bone background with the static gradient in
           * app/globals.css (BUILD-SPEC r25.2 item 5). Until then it has
           * no inline size, so it takes up no visible space alongside the
           * cssfold packet above — see applySheetGeometry()'s own
           * comment. */}
          <div className="pr-vwrap" ref={filmWrapRef}>
            <div className={`pr-vfold${videoOn ? " pr-on" : ""}`}>
              <video
                key={videoKey}
                ref={videoRef}
                muted
                playsInline
                preload="auto"
                src="/begin-unfold.mp4"
              />
              <div className="pr-vfeather" />
            </div>

            {/* The filmed path's ink+date overlay — positioned over the
             * video like the approved preview's own `.overlay` (top:50%,
             * translateY(-50%), centred text; app/globals.css's
             * `.pr-film-overlay`). No emboss/label — the video itself is
             * the packet, the preview's own overlay never had them
             * either. Opacity starts at 0 by CSS default (invisible while
             * this stays mounted during "checking"/cssfold) and is driven
             * to 1 by playVideoFold() the instant the filmed path is
             * chosen, then wiped by its `timeupdate` handler
             * (WIPE_START/WIPE_END) — see frontRef there. */}
            <div className="pr-film-overlay" ref={frontRef}>
              <p className="pr-ink pr-film-name" ref={filmNameRef} />
              <p className="pr-film-date">
                {residence} &middot; {sentDateLabel}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* r25.2 — the document's own opening view IS the reveal now (no
       * separate landing layer, no ease-to-position); on the filmed
       * path, playVideoFold()'s applySheetGeometry() sets this
       * element's own width/marginTop directly off computeSheetGeometry()
       * so it renders exactly on the filmed sheet's on-screen box, and
       * showDoc() (inside playVideoFold()) adds the opacity-only
       * `.pr-landed` fade (BUILD-SPEC item 3) instead of the original
       * `.pr-pre`/`.pr-in` translateY(24px) pair below, which stays the
       * live behaviour for every fallback path (item 6) — see
       * app/globals.css's own comment on both rule sets. */}
      <div ref={docRef} className={`pr-doc${sheetLanded ? " pr-landed" : ""}${docIn ? " pr-in" : " pr-pre"}`}>
        {children}
      </div>
    </>
  );
}
