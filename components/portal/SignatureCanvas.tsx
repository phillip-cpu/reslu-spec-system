"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Plain <canvas> signature pad — pointer events, no dependency (BUILD-
 * SPEC.md working-copy constraint: "signature drawing = plain canvas
 * API", no new deps). Exposes the drawn PNG as a data URL via onChange
 * whenever a stroke ends, and null again after Clear.
 */
export function SignatureCanvas({
  onChange,
}: {
  onChange: (dataUrl: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const hasDrawnRef = useRef(false);
  const [hasDrawn, setHasDrawn] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Scale for device pixel ratio so strokes stay crisp, while CSS
    // size stays fixed — standard canvas-HiDPI pattern.
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.25;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1A1A1A"; // near-black ink, matches brand

    function pos(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function down(e: PointerEvent) {
      drawingRef.current = true;
      const { x, y } = pos(e);
      ctx!.beginPath();
      ctx!.moveTo(x, y);
    }

    function move(e: PointerEvent) {
      if (!drawingRef.current) return;
      const { x, y } = pos(e);
      ctx!.lineTo(x, y);
      ctx!.stroke();
      if (!hasDrawnRef.current) {
        hasDrawnRef.current = true;
        setHasDrawn(true);
      }
    }

    function up() {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      if (hasDrawnRef.current) {
        onChange(canvas!.toDataURL("image/png"));
      }
    }

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    hasDrawnRef.current = false;
    setHasDrawn(false);
    onChange(null);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="h-40 w-full touch-none border border-[#c9c2b4] bg-nearwhite"
        style={{ width: "100%", height: "160px" }}
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-caption text-charcoal/40">
          {hasDrawn ? "Signature captured." : "Draw your signature above."}
        </p>
        <button
          type="button"
          onClick={clear}
          className="text-caption text-charcoal/50 underline hover:text-nearblack"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
