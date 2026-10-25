import { ReactNode, useRef, useState } from "react";
import { Report } from "./state";

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Badge({ tone, children }: { tone: "good" | "bad" | "warn" | "muted" | "info"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Card({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || right) && (
        <header className="card-head">
          <h3>{title}</h3>
          <div>{right}</div>
        </header>
      )}
      {children}
    </section>
  );
}

/** Drag to compare the baseline and monitoring images of the same footprint. */
export function BeforeAfter({ before, after, labels }: { before: string; after: string; labels: [string, string] }) {
  const [pos, setPos] = useState(50);
  const ref = useRef<HTMLDivElement>(null);
  const move = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div
      className="ba"
      ref={ref}
      onMouseMove={(e) => e.buttons === 1 && move(e.clientX)}
      onMouseDown={(e) => move(e.clientX)}
      onTouchMove={(e) => move(e.touches[0].clientX)}
      data-testid="before-after"
    >
      <img src={after} alt={labels[1]} draggable={false} />
      <div className="ba-before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={before} alt={labels[0]} draggable={false} />
      </div>
      <div className="ba-handle" style={{ left: `${pos}%` }}>
        <span />
      </div>
      <div className="ba-tag left">{labels[0]}</div>
      <div className="ba-tag right">{labels[1]}</div>
    </div>
  );
}

export function EvidenceViewer({ id, report, initial = "rgb" }: { id: string; report: Report; initial?: "rgb" | "ndvi" | "change" }) {
  const [mode, setMode] = useState<"rgb" | "ndvi" | "change">(initial);
  const [zoom, setZoom] = useState(true);
  const b = report.data.baseline.year;
  const m = report.data.monitoring.year;
  const base = `reports/${id}/` + (zoom && report.evidence?.["zoom_ndvi_change.png"] ? "zoom_" : "");
  return (
    <div className="evidence">
      <div className="seg">
        {(["rgb", "ndvi", "change"] as const).map((k) => (
          <button key={k} className={mode === k ? "on" : ""} onClick={() => setMode(k)} data-testid={`mode-${k}`}>
            {k === "rgb" ? "True colour" : k === "ndvi" ? "NDVI" : "NDVI change"}
          </button>
        ))}
      </div>
      <div className="seg right">
        <button className={zoom ? "on" : ""} onClick={() => setZoom(true)} data-testid="zoom-project">
          Project
        </button>
        <button className={!zoom ? "on" : ""} onClick={() => setZoom(false)} data-testid="zoom-landscape">
          Landscape
        </button>
      </div>
      {mode === "change" ? (
        <div className="ba">
          <img src={base + "ndvi_change.png"} alt="NDVI change" />
          <div className="ba-tag left">ΔNDVI {b}→{m}</div>
          <div className="legend-change">
            <span>loss</span>
            <i />
            <span>gain</span>
          </div>
        </div>
      ) : (
        <BeforeAfter before={base + (mode === "rgb" ? "baseline_rgb.png" : "baseline_ndvi.png")} after={base + (mode === "rgb" ? "monitoring_rgb.png" : "monitoring_ndvi.png")} labels={[`${b} baseline`, `${m} monitoring`]} />
      )}
      <div className="evidence-foot">
        <span>
          <i className="sw poly" /> project polygon
        </span>
        <span>
          <i className="sw ring" /> control ring (300–1500 m)
        </span>
        <span className="muted">Sentinel-2 L2A · 10 m · tile {report.data.mgrsTile} · median of {report.data.baseline.scenes.length}+{report.data.monitoring.scenes.length} cloud-masked scenes</span>
      </div>
    </div>
  );
}

export function Checks({ report }: { report: Report }) {
  const fmt = (c: Report["checks"][number]) => {
    if (c.id === "coverage") return `${(c.value * 100).toFixed(1)}% ≥ ${c.threshold * 100}%`;
    if (c.id === "netGain" || c.id === "robustness") return `${c.value >= 0 ? "+" : ""}${c.value.toFixed(3)} ≥ +${c.threshold}`;
    if (c.id === "canopy") return `${c.value} ha ≥ ${c.threshold} ha`;
    if (c.id === "boundary") return `worst ${c.value >= 0 ? "+" : ""}${c.value.toFixed(3)} ≥ +${c.threshold}`;
    if (c.id === "dryPersistence") return `${(c.value * 100).toFixed(0)}% ≥ ${c.threshold * 100}%`;
    if (c.id === "placebo") return `p = ${c.value.toFixed(3)} ≤ ${c.threshold}`;
    return `${c.value} ≥ ${c.threshold}`;
  };
  return (
    <ul className="checks">
      {report.checks.map((c) => (
        <li key={c.id} className={c.pass ? "pass" : "fail"}>
          <span className="tick">{c.pass ? "✓" : "✕"}</span>
          <span className="lbl">{c.label}</span>
          <span className="val">{fmt(c)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Small bar chart: project vs control NDVI in both windows. */
export function DidChart({ report }: { report: Report }) {
  const r = report.results as Record<string, number>;
  const rows = [
    { k: "Project", a: r.projectNdviBaseline, b: r.projectNdviMonitoring },
    { k: "Control ring", a: r.controlNdviBaseline, b: r.controlNdviMonitoring },
  ];
  const x = (v: number) => `${Math.max(0, Math.min(1, v / 0.8)) * 100}%`;
  return (
    <div className="did">
      {rows.map((row) => (
        <div className="did-row" key={row.k}>
          <div className="did-k">{row.k}</div>
          <div className="did-track">
            <div className="did-bar base" style={{ width: x(row.a) }}>
              <span>{row.a.toFixed(2)}</span>
            </div>
            <div className="did-bar mon" style={{ width: x(row.b) }}>
              <span>{row.b.toFixed(2)}</span>
            </div>
          </div>
          <div className={`did-d ${row.b - row.a >= 0 ? "up" : "down"}`}>
            {row.b - row.a >= 0 ? "+" : ""}
            {(row.b - row.a).toFixed(3)}
          </div>
        </div>
      ))}
      <div className="did-net">
        <span>Net gain attributable to the project</span>
        <strong className={r.netGain >= 0.05 ? "good" : "bad"}>
          {r.netGain >= 0 ? "+" : ""}
          {r.netGain.toFixed(3)} NDVI
        </strong>
      </div>
      <div className="did-legend">
        <span>
          <i className="sw base" /> {report.data.baseline.year}
        </span>
        <span>
          <i className="sw mon" /> {report.data.monitoring.year}
        </span>
      </div>
    </div>
  );
}

export function Hash({ value, href }: { value: string; href?: string }) {
  const [copied, setCopied] = useState(false);
  const txt = `${value.slice(0, 10)}…${value.slice(-6)}`;
  return (
    <span className="hash" title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {txt}
        </a>
      ) : (
        txt
      )}
      <button
        onClick={() => {
          navigator.clipboard?.writeText(value).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        aria-label="copy"
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}
