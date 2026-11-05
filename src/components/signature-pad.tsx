"use client";
// Draw-to-sign box for phones and tablets. Writes the drawing as a PNG data URL into a hidden input.
import { useEffect, useRef, useState } from "react";

export function SignaturePad({ name = "signature" }: { name?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState("");
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const signed = useRef(false);

  useEffect(() => {
    const c = canvas.current!;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    let lastWidth = 0;
    const resize = () => {
      const w = c.parentElement!.clientWidth;
      // Phones fire resize when the address bar hides on scroll; only redraw the box when its width
      // really changes, and never wipe a signature that's already there.
      if (w === lastWidth || (lastWidth && signed.current)) return;
      lastWidth = w;
      c.width = w * ratio; c.height = 160 * ratio; c.style.width = `${w}px`; c.style.height = "160px";
      const ctx = c.getContext("2d")!; ctx.scale(ratio, ratio); ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111";
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, 160);
      setData("");
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const pos = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => { e.preventDefault(); canvas.current!.setPointerCapture(e.pointerId); drawing.current = true; last.current = pos(e); };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const p = pos(e); const ctx = canvas.current!.getContext("2d")!;
    ctx.beginPath(); ctx.moveTo(last.current!.x, last.current!.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last.current = p;
  };
  const up = () => { if (!drawing.current) return; drawing.current = false; signed.current = true; setData(canvas.current!.toDataURL("image/png")); };
  const clear = () => { const c = canvas.current!; const ctx = c.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); signed.current = false; setData(""); };

  return (
    <div>
      <div style={{ border: "1px solid var(--rule, #ccc)", borderRadius: 8, background: "#fff", touchAction: "none" }}>
        <canvas ref={canvas} aria-label="Signature box: sign with your finger or mouse" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
      </div>
      <div className="row" style={{ marginTop: 4, justifyContent: "space-between" }}>
        <span className="small muted">{data ? "Signed" : "Sign above"}</span>
        <button type="button" className="btn-sm" onClick={clear}>Clear</button>
      </div>
      <input type="hidden" name={name} value={data} />
    </div>
  );
}
