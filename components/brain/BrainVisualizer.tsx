"use client";

import { useEffect, useRef, useState } from "react";

/**
 * RESLU Second Brain, Step 13 (docs/RESLU-second-brain-build-brief.md).
 *
 * Ports docs/brain-visualizer-reference.html's canvas rendering
 * almost verbatim — rendering, palette, motion, typography and layout
 * are FROZEN per that file's own header comment. Engineering changes
 * made here, and ONLY here:
 *
 *   1. CL[]'s per-cluster `cnt` (count) and the individual-dot pool
 *      now come from real data (/api/second-brain/brain-data) instead
 *      of the reference's hardcoded numbers/names. Colour (`c`),
 *      sector angles (`a0`/`a1`), density feel, and blob position
 *      (`bx`/`by`) are copied verbatim from the reference file — this
 *      is the visual identity the brief says is frozen.
 *   2. The reference's dot-generation loop (a density-driven grid
 *      sweep, unrelated to any real record count) is replaced with
 *      one dot per REAL eligible record (flagged or touched in the
 *      last 90 days, server-side capped at 1,500 total across every
 *      cluster — see the API route) — this is the brief's own
 *      "aggregation rule (fixed, not a judgment call)", not a style
 *      change. Each dot still lands at a random (r, angle) within the
 *      exact same radius/angle range the reference used, preserving
 *      the look; only the COUNT and WHICH records get a dot changed.
 *   3. A click handler was added (the reference only had hover
 *      tooltips) — clicking a named dot with a recordUrl navigates
 *      there, per the brief's "clicking a flagged item opens its
 *      record".
 *   4. The flagged-record ring's stroke colour changed from the
 *      reference's white (`rgba(255,255,255,0.28)`) to amber
 *      (`rgba(201,128,58,0.65)`, matching this SAME file's own
 *      existing amber convention for the ARIA node/routine ring) —
 *      the brief's literal requirement is "Amber ring = record with
 *      an open change_proposals row", not a discretionary aesthetic
 *      choice, so this one colour value is the one deliberate
 *      departure from a verbatim port. Every other colour, position,
 *      and animation value below is copied unchanged.
 *   5. RT[] comes from the real vercel.json cron definitions (via the
 *      API route) instead of the reference's invented strings. APPS[]
 *      stays hardcoded verbatim, per the brief ("hex ring apps stay
 *      hardcoded").
 */

type BrainRecord = { id: string; name: string; flagged: boolean; recentAt: string; recordUrl: string | null };
type BrainCluster = { entityType: string; label: string; totalCount: number; records: BrainRecord[] };
type BrainData = { clusters: BrainCluster[]; routines: string[]; totalDots: number };

// Frozen visual identity per cluster — copied verbatim from
// docs/brain-visualizer-reference.html's CL[] (colour, sector angles,
// blob position). Keyed by entityType so real data can be merged in.
const CLUSTER_VISUALS: Record<string, { c: string; a0: number; a1: number; bx: number; by: number }> = {
  email: { c: "#b9aee6", a0: -1.25, a1: 0.95, bx: 0.66, by: 0.32 },
  item: { c: "#c47fd3", a0: 2.0, a1: 3.0, bx: 0.32, by: 0.7 },
  project: { c: "#8fd0c9", a0: 3.6, a1: 4.25, bx: 0.3, by: 0.26 },
  diary_sow: { c: "#d8c98a", a0: 4.45, a1: 5.0, bx: 0.52, by: 0.16 },
  lead: { c: "#7d9cd8", a0: 3.05, a1: 3.5, bx: 0.13, by: 0.44 },
};

const APPS: [string, string][] = [
  ["G", "Gmail"],
  ["S", "Supabase"],
  ["V", "Vercel"],
  ["O", "Ollama · mac mini"],
  ["C", "Claude"],
  ["X", "Xero"],
  ["D", "Drive"],
  ["H", "GitHub"],
  ["Q", "aria_queue"],
  ["W", "workspace_index"],
  ["P", "pdf pipeline"],
  ["M", "MCP tools"],
];

export function BrainVisualizer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<BrainData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/second-brain/brain-data")
      .then((res) => {
        if (!res.ok) throw new Error(`brain-data request failed: ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  useEffect(() => {
    if (!data || !canvasRef.current || !tipRef.current) return;
    return mountVisualizer(canvasRef.current, tipRef.current, data);
  }, [data]);

  return (
    <>
      <div
        id="stage"
        style={{
          position: "relative",
          maxWidth: 960,
          margin: "24px auto",
          background: "#08080c",
          borderRadius: 14,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <canvas ref={canvasRef} id="rb2" style={{ width: "100%", height: 760, display: "block" }} />
        <div
          id="panel"
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            width: 172,
            background: "rgba(14,14,20,0.88)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 10,
            padding: "12px 14px",
            fontSize: 11,
            color: "#8a8aa0",
          }}
        >
          <input
            type="text"
            id="srch"
            placeholder={`Search ${data ? data.clusters.reduce((n, c) => n + c.totalCount, 0).toLocaleString() : "…"} records… ( / )`}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.09)",
              color: "#c8c8d6",
              fontSize: 11,
              padding: "6px 8px",
              borderRadius: 6,
              outline: "none",
            }}
          />
          <p style={{ margin: "12px 0 5px", letterSpacing: 2, fontSize: 10, color: "#66667a" }}>LAYOUT</p>
          <div style={{ display: "flex", gap: 4 }}>
            {[
              { label: "Force", m: "1" },
              { label: "Circle", m: "0" },
              { label: "Hex", m: "0" },
              { label: "Rings", m: "0", on: true },
            ].map((b) => (
              <button
                key={b.label}
                className={`lb2${b.on ? " on" : ""}`}
                data-m={b.m}
                style={{
                  flex: 1,
                  fontSize: 11,
                  padding: "3px 0",
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "#a8a8ba",
                  borderRadius: 5,
                  cursor: "pointer",
                }}
              >
                {b.label}
              </button>
            ))}
          </div>
          <p style={{ margin: "12px 0 5px", letterSpacing: 2, fontSize: 10, color: "#66667a" }}>RING SPIN</p>
          <input id="spin2" type="range" min="0" max="1" step="0.01" defaultValue="0.15" style={{ width: "100%", accentColor: "#c9803a" }} />
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 11, color: "#8a8aa0" }}>
            <input id="fn2" type="checkbox" style={{ width: 12, height: 12 }} />
            Record names
          </label>
        </div>
        <div
          ref={tipRef}
          id="tip2"
          style={{
            position: "absolute",
            display: "none",
            background: "rgba(18,18,26,0.95)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 6,
            padding: "5px 10px",
            fontSize: 11,
            color: "#d8d8e4",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            letterSpacing: 0.3,
          }}
        />
      </div>
      {error && (
        <p style={{ textAlign: "center", color: "#d8877d", fontFamily: "sans-serif", fontSize: 13 }}>Failed to load: {error}</p>
      )}
    </>
  );
}

type Dot = {
  cl: { entityType: string; n: string; c: string; a0: number; a1: number; bx: number; by: number; cnt: string };
  r: number;
  a: number;
  s: number;
  i: number;
  al: number;
  nm: string | null;
  pr: boolean;
  cnt?: string;
  recordUrl: string | null;
  px?: number;
  py?: number;
};

function mountVisualizer(canvas: HTMLCanvasElement, tip: HTMLDivElement, data: BrainData): () => void {
  const X = canvas.getContext("2d")!;
  let W = 960,
    H = 760,
    cx = 480,
    cy = 380;

  function fit() {
    const d = window.devicePixelRatio || 1;
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * d;
    canvas.height = H * d;
    X.setTransform(d, 0, 0, d, 0, 0);
    cx = W / 2;
    cy = H / 2;
  }
  fit();
  window.addEventListener("resize", fit);

  function hx(c: string): [number, number, number] {
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  }
  function sh(c: string, p: number): string {
    const [r, g, b] = hx(c);
    const f = p < 0 ? 0 : 255,
      a = Math.abs(p);
    return "rgb(" + Math.round(r + (f - r) * a) + "," + Math.round(g + (f - g) * a) + "," + Math.round(b + (f - b) * a) + ")";
  }
  function rgba(c: string, a: number): string {
    const [r, g, b] = hx(c);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  const SPR: Record<string, HTMLCanvasElement> = {};
  function spr(c: string): HTMLCanvasElement {
    if (SPR[c]) return SPR[c];
    const s = document.createElement("canvas");
    s.width = 64;
    s.height = 64;
    const x2 = s.getContext("2d")!;
    let g = x2.createRadialGradient(32, 32, 10, 32, 32, 30);
    g.addColorStop(0, rgba(c, 0.22));
    g.addColorStop(1, rgba(c, 0));
    x2.fillStyle = g;
    x2.beginPath();
    x2.arc(32, 32, 30, 0, 6.283);
    x2.fill();
    g = x2.createRadialGradient(27, 26, 2, 32, 32, 16);
    g.addColorStop(0, sh(c, 0.55));
    g.addColorStop(0.45, c);
    g.addColorStop(1, sh(c, -0.38));
    x2.fillStyle = g;
    x2.beginPath();
    x2.arc(32, 32, 16, 0, 6.283);
    x2.fill();
    SPR[c] = s;
    return s;
  }

  const CL = data.clusters.flatMap((cluster) => {
    const visual = CLUSTER_VISUALS[cluster.entityType];
    if (!visual) return [];
    return [
      {
        entityType: cluster.entityType,
        n: cluster.label,
        ...visual,
        cnt: cluster.totalCount.toLocaleString(),
        records: cluster.records,
      },
    ];
  });

  const dots: Dot[] = [];
  CL.forEach((cl) => {
    cl.records.forEach((rec, i) => {
      const r = 104 + Math.random() * (212 - 104);
      const a = cl.a0 + Math.random() * (cl.a1 - cl.a0);
      const isBig = i < 6;
      const s = isBig ? 4.5 + Math.random() * 3 : 1.5 + Math.random() * 2.1;
      dots.push({
        cl,
        r,
        a,
        s,
        i,
        al: 0.6 + Math.random() * 0.4,
        nm: isBig ? rec.name : null,
        pr: rec.flagged,
        recordUrl: rec.recordUrl,
      });
    });
    const clusterDots = dots.filter((d) => d.cl === cl).sort((x, y) => y.s - x.s);
    if (clusterDots[0]) {
      clusterDots[0].s = 9.5;
      clusterDots[0].cnt = cl.cnt;
      clusterDots[0].al = 1;
    }
  });

  const webs: [Dot, Dot][] = [];
  CL.forEach((cl) => {
    const ds = dots.filter((d) => d.cl === cl);
    for (let k = 0; k < Math.min(30, ds.length); k++) {
      webs.push([ds[Math.floor(Math.random() * ds.length)], ds[Math.floor(Math.random() * ds.length)]]);
    }
  });

  const HEXT = document.createElement("canvas");
  HEXT.width = 440;
  HEXT.height = 440;
  (function () {
    const x2 = HEXT.getContext("2d")!;
    x2.save();
    x2.beginPath();
    x2.arc(220, 220, 218, 0, 6.283);
    x2.clip();
    x2.strokeStyle = "rgba(255,255,255,0.05)";
    x2.lineWidth = 0.5;
    const s = 13;
    for (let row = 0; row < 28; row++)
      for (let col = 0; col < 24; col++) {
        const px = col * s * 1.73 + (row % 2 ? s * 0.87 : 0),
          py = row * s * 1.5;
        x2.beginPath();
        for (let h = 0; h < 6; h++) {
          const ha = (h / 6) * 6.283 + 1.5708;
          const qx = px + s * Math.cos(ha),
            qy = py + s * Math.sin(ha);
          h ? x2.lineTo(qx, qy) : x2.moveTo(qx, qy);
        }
        x2.closePath();
        x2.stroke();
      }
    x2.restore();
  })();

  const RT = data.routines.length ? data.routines : ["(no cron definitions found)"];

  let m = 0,
    tgt = 0,
    rot = 0,
    spd = 0.15,
    names = false,
    hit: { x: number; y: number; r: number; t: string; url?: string | null }[] = [],
    mx = -99,
    my = -99,
    q = "";

  const layoutButtons = document.querySelectorAll<HTMLButtonElement>(".lb2");
  layoutButtons.forEach((b) => {
    b.onclick = () => {
      tgt = +(b.dataset.m ?? "0");
      layoutButtons.forEach((o) => o.classList.remove("on"));
      b.classList.add("on");
    };
  });
  const spinInput = document.getElementById("spin2") as HTMLInputElement;
  spinInput.oninput = (e) => (spd = +(e.target as HTMLInputElement).value);
  const namesCheckbox = document.getElementById("fn2") as HTMLInputElement;
  namesCheckbox.onchange = (e) => (names = (e.target as HTMLInputElement).checked);
  const searchInput = document.getElementById("srch") as HTMLInputElement;
  searchInput.oninput = (e) => (q = (e.target as HTMLInputElement).value.toLowerCase().trim());

  function match(d: Dot): boolean {
    if (!q) return true;
    return (!!d.nm && d.nm.toLowerCase().includes(q)) || d.cl.n.toLowerCase().includes(q);
  }
  function lp(a: number, b: number): number {
    return a + (b - a) * m;
  }
  function blob(cl: Dot["cl"], i: number): [number, number] {
    const br = 5.4 * Math.sqrt(i),
      ba = i * 2.39996;
    return [cl.bx * W + br * Math.cos(ba), cl.by * H + br * Math.sin(ba)];
  }
  function cap(t2: string, x: number, y: number, c: string, sz?: number) {
    X.letterSpacing = "3px";
    X.fillStyle = c;
    X.font = "400 " + (sz || 11) + "px sans-serif";
    X.textAlign = "center";
    X.fillText(t2, x, y);
    X.letterSpacing = "0px";
  }

  let rafId: number;
  function draw(t: number) {
    m += (tgt - m) * 0.06;
    rot += spd * 0.0012;
    X.fillStyle = "#08080c";
    X.fillRect(0, 0, W, H);
    const fade = 1 - m;
    if (fade > 0.02) {
      X.globalAlpha = fade;
      let g = X.createRadialGradient(cx, cy, 30, cx, cy, 224);
      g.addColorStop(0, "rgba(32,22,50,0.85)");
      g.addColorStop(0.8, "rgba(24,17,38,0.5)");
      g.addColorStop(1, "rgba(24,17,38,0)");
      X.fillStyle = g;
      X.beginPath();
      X.arc(cx, cy, 226, 0, 6.283);
      X.fill();
      X.globalAlpha = fade * 0.6;
      X.drawImage(HEXT, cx - 220, cy - 220);
      X.globalAlpha = fade;
      X.strokeStyle = "rgba(125,156,216,0.22)";
      X.lineWidth = 0.75;
      X.beginPath();
      X.arc(cx, cy, 292, 0, 6.283);
      X.stroke();
      X.strokeStyle = "rgba(199,154,78,0.28)";
      X.beginPath();
      X.arc(cx, cy, 250, 0, 6.283);
      X.stroke();
      X.strokeStyle = "rgba(255,255,255,0.05)";
      X.beginPath();
      X.arc(cx, cy, 224, 0, 6.283);
      X.stroke();
      cap("APPLICATIONS", cx, cy - 280, "rgba(143,178,221,0.75)", 12);
      cap("ROUTINES", cx, cy - 237, "rgba(199,154,78,0.8)", 12);
      cap("MEMORY", cx, cy - 200, "rgba(143,123,216,0.8)", 12);
      cap("SKILLS", cx, cy - 90, "rgba(201,128,58,0.9)", 12);
      X.globalAlpha = 1;
    }
    dots.forEach((d) => {
      const a = d.a + rot;
      const B = blob(d.cl, d.i);
      d.px = lp(cx + d.r * Math.cos(a), B[0]);
      d.py = lp(cy + d.r * Math.sin(a), B[1]);
    });
    X.lineWidth = 0.5;
    webs.forEach(([A, B]) => {
      X.strokeStyle = rgba(A.cl.c, 0.045);
      X.beginPath();
      X.moveTo(A.px!, A.py!);
      X.lineTo(B.px!, B.py!);
      X.stroke();
    });
    const sr: [number, number][] = [
      [44, 26],
      [60, 36],
      [76, 46],
    ];
    sr.forEach(([r, n], ri) => {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 6.283 + rot * (ri % 2 ? -1.1 : 1.1);
        const rx = lp(cx + r * Math.cos(a), 0.21 * W + 4.8 * Math.sqrt(ri * 46 + k) * Math.cos((ri * 46 + k) * 2.4));
        const ry = lp(cy + r * Math.sin(a), 0.83 * H + 4.8 * Math.sqrt(ri * 46 + k) * Math.sin((ri * 46 + k) * 2.4));
        X.save();
        X.translate(rx, ry);
        X.rotate(0.785 + rot * 2);
        X.fillStyle = "rgba(201,128,58,0.85)";
        X.fillRect(-1.6, -1.6, 3.2, 3.2);
        X.restore();
      }
    });
    hit = [];
    dots.forEach((d) => {
      X.globalAlpha = match(d) ? d.al : 0.15;
      X.drawImage(spr(d.cl.c), d.px! - d.s * 2, d.py! - d.s * 2, d.s * 4, d.s * 4);
      X.globalAlpha = 1;
      if (d.pr && d.s > 3) {
        // Amber, not the reference's white — "Amber ring = record with
        // an open change_proposals row" per the brief. See this file's
        // top-of-file comment for why this is the one deliberate
        // colour departure from the frozen reference.
        X.strokeStyle = "rgba(201,128,58,0.65)";
        X.lineWidth = 0.75;
        X.beginPath();
        X.ellipse(d.px!, d.py!, d.s * 2.1, d.s * 0.65, -0.35, 0, 6.283);
        X.stroke();
      }
      if (d.cnt) {
        X.fillStyle = sh(d.cl.c, -0.72);
        X.font = "500 11px sans-serif";
        X.textAlign = "center";
        X.fillText(d.cnt, d.px!, d.py! + 3.5);
      }
      if (d.nm) {
        hit.push({ x: d.px!, y: d.py!, r: d.s + 3, t: d.nm + " · " + d.cl.n.toLowerCase(), url: d.recordUrl });
        if (names) {
          X.fillStyle = "rgba(255,255,255,0.42)";
          X.font = "11px sans-serif";
          X.textAlign = "center";
          X.fillText(d.nm, d.px!, d.py! + d.s + 12);
        }
      }
    });
    CL.forEach((cl) => {
      const ma = (cl.a0 + cl.a1) / 2 + rot;
      const x = lp(cx + 90 * Math.cos(ma), cl.bx * W),
        y = lp(cy + 90 * Math.sin(ma), cl.by * H);
      X.drawImage(spr(cl.c), x - 14, y - 14, 28, 28);
      X.strokeStyle = "rgba(255,255,255,0.35)";
      X.lineWidth = 0.75;
      X.beginPath();
      X.arc(x, y, 10, 0, 6.283);
      X.stroke();
      cap(cl.n, x, y + 24, "rgba(255,255,255,0.68)");
      hit.push({ x, y, r: 12, t: cl.n + " · " + cl.cnt + " records" });
    });
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 6.283 + rot * 0.35 - 1.57;
      const x = lp(cx + 250 * Math.cos(a), 0.78 * W + 5.8 * Math.sqrt(k) * Math.cos(k * 2.4) * 2.2),
        y = lp(cy + 250 * Math.sin(a), 0.83 * H + 5.8 * Math.sqrt(k) * Math.sin(k * 2.4) * 2.2);
      X.strokeStyle = "rgba(199,154,78,0.45)";
      X.lineWidth = 0.75;
      X.beginPath();
      X.arc(x, y, 7.5, 0, 6.283);
      X.stroke();
      X.fillStyle = "#c79a4e";
      X.beginPath();
      X.arc(x, y, 2.8, 0, 6.283);
      X.fill();
      if (k % 4 === 0) {
        const sa = t * 0.0016 + k;
        X.fillStyle = "rgba(232,201,138,0.8)";
        X.beginPath();
        X.arc(x + 10.5 * Math.cos(sa), y + 10.5 * Math.sin(sa), 1.3, 0, 6.283);
        X.fill();
      }
      hit.push({ x, y, r: 9, t: RT[k % RT.length] });
    }
    APPS.forEach(([L, nm2], k) => {
      const a = (k / APPS.length) * 6.283 + 0.13 + rot * 0.18 - 1.57;
      const x = lp(cx + 292 * Math.cos(a), 0.5 * W + ((k % 4) - 1.5) * 36),
        y = lp(cy + 292 * Math.sin(a), 0.92 * H + (Math.floor(k / 4) - 1) * 32);
      X.fillStyle = "rgba(16,21,31,0.9)";
      X.strokeStyle = "rgba(125,156,216,0.4)";
      X.lineWidth = 0.75;
      X.beginPath();
      for (let h2 = 0; h2 < 6; h2++) {
        const ha = (h2 / 6) * 6.283 + 1.5708;
        const px = x + 14 * Math.cos(ha),
          py = y + 14 * Math.sin(ha);
        h2 ? X.lineTo(px, py) : X.moveTo(px, py);
      }
      X.closePath();
      X.fill();
      X.stroke();
      X.fillStyle = "rgba(207,224,245,0.78)";
      X.font = "400 11px sans-serif";
      X.textAlign = "center";
      X.fillText(L, x, y + 4);
      hit.push({ x, y, r: 15, t: nm2 });
    });
    const ax = cx,
      ay = lp(cy, 0.45 * H);
    const g2 = X.createRadialGradient(ax, ay, 4, ax, ay, 26);
    g2.addColorStop(0, "rgba(201,128,58,0.3)");
    g2.addColorStop(1, "rgba(201,128,58,0)");
    X.fillStyle = g2;
    X.beginPath();
    X.arc(ax, ay, 26, 0, 6.283);
    X.fill();
    X.fillStyle = "#160d05";
    X.strokeStyle = "rgba(201,128,58,0.9)";
    X.lineWidth = 1;
    X.beginPath();
    X.roundRect(ax - 11, ay - 11, 22, 22, 5);
    X.fill();
    X.stroke();
    X.fillStyle = "#c9803a";
    X.font = "500 11px sans-serif";
    X.textAlign = "center";
    X.fillText("A", ax, ay + 4);
    cap("ARIA.MD", ax, ay + 30, "rgba(255,255,255,0.8)");
    const g3 = X.createRadialGradient(cx, cy, H * 0.32, cx, cy, H * 0.58);
    g3.addColorStop(0, "rgba(8,8,12,0)");
    g3.addColorStop(1, "rgba(4,4,7,0.55)");
    X.fillStyle = g3;
    X.fillRect(0, 0, W, H);
    const h3 = hit.find((h) => {
      const dx = h.x - mx,
        dy = h.y - my;
      return dx * dx + dy * dy < h.r * h.r;
    });
    if (h3) {
      X.strokeStyle = "rgba(255,255,255,0.4)";
      X.lineWidth = 0.75;
      X.beginPath();
      X.arc(h3.x, h3.y, h3.r + 3, 0, 6.283);
      X.stroke();
      tip.style.display = "block";
      tip.style.left = Math.min(mx + 14, W - 170) + "px";
      tip.style.top = h3.y - 32 + "px";
      tip.textContent = h3.t;
      canvas.style.cursor = h3.url ? "pointer" : "default";
    } else {
      tip.style.display = "none";
      canvas.style.cursor = "default";
    }
    rafId = requestAnimationFrame(draw);
  }
  rafId = requestAnimationFrame(draw);

  function onMouseMove(e: MouseEvent) {
    const b = canvas.getBoundingClientRect();
    mx = e.clientX - b.left;
    my = e.clientY - b.top;
  }
  function onMouseLeave() {
    mx = -99;
    my = -99;
  }
  function onClick() {
    const h3 = hit.find((h) => {
      const dx = h.x - mx,
        dy = h.y - my;
      return dx * dx + dy * dy < h.r * h.r;
    });
    if (h3?.url) {
      window.location.href = h3.url;
    }
  }
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseleave", onMouseLeave);
  canvas.addEventListener("click", onClick);

  return () => {
    cancelAnimationFrame(rafId);
    window.removeEventListener("resize", fit);
    canvas.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("mouseleave", onMouseLeave);
    canvas.removeEventListener("click", onClick);
  };
}
