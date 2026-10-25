import { useState } from "react";
import { Contract } from "ethers";
import { useApp, useChain } from "./state";
import { Badge, Card, Checks, DidChart, EvidenceViewer, Hash, Spinner, Stat } from "./components";
import { DEMO_PERSONAS, NETWORKS, OUTCOME, SERIAL_STATUS, decodeError, demoWallet, pofContract, serialLabel, short } from "./chain";

const nf = new Intl.NumberFormat("en-IN");

type ProjectView = {
  id: string;
  projectId: bigint;
  name: string;
  developer: string;
  totalIssued: bigint;
  totalBuffer: bigint;
  rejections: number;
  outcome?: number;
  batches: bigint[];
};

function useProjects() {
  const { read, deployment } = useApp();
  return useChain<ProjectView[]>(async () => {
    const out: ProjectView[] = [];
    for (const c of deployment!.cases) {
      const p = await read!.getProject(c.projectId);
      const vs: bigint[] = await read!.projectVerifications(c.projectId);
      const last = vs.length ? await read!.getVerification(vs[vs.length - 1]) : undefined;
      out.push({
        id: c.id,
        projectId: BigInt(c.projectId),
        name: p.name,
        developer: p.developer,
        totalIssued: p.totalIssued,
        totalBuffer: p.totalBuffer,
        rejections: Number(p.rejections),
        outcome: last ? Number(last.outcome) : undefined,
        batches: await read!.projectBatches(c.projectId),
      });
    }
    return out;
  }, [deployment]);
}

function useTotals() {
  const { read } = useApp();
  return useChain(async () => {
    const [projects, batches, retirements, verifications, retired, nextSerial] = await Promise.all([
      read!.projectCount(),
      read!.batchCount(),
      read!.retirementCount(),
      read!.verificationCount(),
      read!.totalRetired(),
      read!.nextSerial(),
    ]);
    return { projects, batches, retirements, verifications, retired, serials: nextSerial - 1n };
  });
}

export function statusBadge(outcome?: number) {
  if (outcome === undefined) return <Badge tone="muted">Awaiting verification</Badge>;
  if (outcome === 1) return <Badge tone="good">Verified · credits issued</Badge>;
  return <Badge tone="bad">{OUTCOME[outcome]}</Badge>;
}

// ------------------------------------------------------------------------------------------- registry

export function Registry() {
  const { cases, reports, deployment } = useApp();
  const projects = useProjects();
  const totals = useTotals();
  return (
    <div className="page">
      <div className="hero">
        <div>
          <div className="eyebrow">Satellite-verified carbon credits</div>
          <h1>
            Credits that exist only if <em>the forest does</em>.
          </h1>
          <p className="lede">
            ProofOfForest measures every reforestation claim with free Copernicus Sentinel-2 imagery, compares it against the surrounding landscape, and lets an oracle committee sign the result. The smart contract mints
            only when the evidence passes, numbers every tonne, and burns it forever on retirement.
          </p>
        </div>
        <div className="hero-stats">
          <Stat label="Projects registered" value={totals ? String(totals.projects) : "–"} />
          <Stat label="Verifications on-chain" value={totals ? String(totals.verifications) : "–"} />
          <Stat label="Serial numbers issued" value={totals ? nf.format(Number(totals.serials)) : "–"} sub="tCO2e incl. buffer pool" tone="good" />
          <Stat label="Tonnes retired" value={totals ? nf.format(Number(totals.retired)) : "–"} sub={totals ? `${totals.retirements} retirement certificates` : ""} />
        </div>
      </div>

      <h2 className="section">Projects</h2>
      <div className="grid3">
        {cases.map((c) => {
          const rep = reports[c.id];
          const pv = projects?.find((p) => p.id === c.id);
          if (!rep) return null;
          return (
            <a className="pcard" href={`#/project/${c.id}`} key={c.id} data-testid={`project-${c.id}`}>
              <div className="pcard-img">
                <img src={`reports/${c.id}/monitoring_rgb.png`} alt="" />
                <div className="pcard-tag">#{pv ? String(pv.projectId) : "…"}</div>
              </div>
              <div className="pcard-body">
                <div className="pcard-top">{statusBadge(pv?.outcome)}</div>
                <h3>{c.name}</h3>
                <div className="muted small">{c.location}</div>
                <div className="pcard-metrics">
                  <div>
                    <span>Area</span>
                    <b>{rep.project.areaHa} ha</b>
                  </div>
                  <div>
                    <span>Period</span>
                    <b>
                      {rep.data.baseline.year}–{rep.data.monitoring.year}
                    </b>
                  </div>
                  <div>
                    <span>Credits</span>
                    <b>{pv && pv.outcome === 1 ? nf.format(Number(pv.totalIssued + pv.totalBuffer)) + " t" : "—"}</b>
                  </div>
                </div>
              </div>
            </a>
          );
        })}
      </div>
      {deployment && (
        <p className="muted small foot-note">
          Contract <Hash value={deployment.address} href={explorerAddr(deployment)} /> on {NETWORKS[deployment.chainId]?.name ?? `chain ${deployment.chainId}`} · oracle committee {deployment.threshold}-of-{deployment.oracles.length}
        </p>
      )}
    </div>
  );
}

function explorerAddr(d: { chainId: string; address: string }) {
  const ex = NETWORKS[d.chainId]?.explorer;
  return ex ? `${ex}/address/${d.address}` : undefined;
}
function explorerTx(chainId: string, tx?: string) {
  const ex = NETWORKS[chainId]?.explorer;
  return ex && tx ? `${ex}/tx/${tx}` : undefined;
}

// ------------------------------------------------------------------------------------------- project

export function ProjectPage({ id }: { id: string }) {
  const { reports, cases, deployment, read, signer, refresh, toast, chainId } = useApp();
  const projects = useProjects();
  const report = reports[id];
  const meta = cases.find((c) => c.id === id);
  const signed = deployment?.cases.find((c) => c.id === id);
  const pv = projects?.find((p) => p.id === id);
  const [busy, setBusy] = useState(false);
  const [lastTx, setLastTx] = useState<string>();
  const batch = useChain(async () => (pv && pv.batches.length ? read!.getBatch(pv.batches[pv.batches.length - 1]) : undefined), [pv?.batches.length]);
  if (!report || !meta) return <div className="page">Loading…</div>;
  const r = report.results as Record<string, number>;
  const naive = report.results.naiveWouldPass === true;

  const submit = async () => {
    if (!signer || !deployment || !signed) return toast("Connect a wallet first", "err");
    setBusy(true);
    const c = pofContract(deployment.address, signer);
    try {
      const tx = await c.submitVerification(signed.attestation, signed.signatures);
      setLastTx(tx.hash);
      await tx.wait();
      toast(signed.attestation.passed ? "Verification accepted: credits minted to the developer" : "Rejection recorded permanently on-chain", signed.attestation.passed ? "ok" : "err");
      refresh();
    } catch (e) {
      toast(decodeError(e, c as Contract), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <a className="back" href="#/">
        ← All projects
      </a>
      <div className="phead">
        <div>
          <div className="eyebrow">Project #{pv ? String(pv.projectId) : "…"} · {meta.location}</div>
          <h1 className="h1-sm">{meta.name}</h1>
          <p className="claim">
            <span className="muted">Claim:</span> {meta.claim}
          </p>
        </div>
        <div className="phead-status">{statusBadge(pv?.outcome)}</div>
      </div>

      <div className="two">
        <Card title="Satellite evidence" right={<span className="muted small">drag to compare</span>}>
          <EvidenceViewer id={id} report={report} />
        </Card>
        <div className="stack">
          <Card title="Oracle verdict" right={report.passed ? <Badge tone="good">PASS</Badge> : <Badge tone="bad">FAIL</Badge>}>
            <DidChart report={report} />
            {naive && !report.passed && (
              <div className="callout warn" data-testid="naive-callout">
                <b>Greenwashing caught.</b> NDVI inside the polygon rose by {r.naiveGain >= 0 ? "+" : ""}
                {r.naiveGain.toFixed(2)}, so a naive before/after check would have issued credits. But the control ring around it rose by {r.controlDelta >= 0 ? "+" : ""}
                {r.controlDelta.toFixed(2)} as well: the whole landscape greened between a drought year and a wet monsoon. The project itself added nothing.
              </div>
            )}
            {!report.passed && !naive && r.netGain < 0 && (
              <div className="callout bad">
                <b>Vegetation was lost, not gained.</b> NDVI inside the claimed area fell from {r.projectNdviBaseline.toFixed(2)} to {r.projectNdviMonitoring.toFixed(2)} while the surroundings stayed stable.
              </div>
            )}
            <Checks report={report} />
          </Card>
        </div>
      </div>

      {report.validation && (
        <Card title="Could this be luck, a cherry-picked boundary, or just grass?" right={<span className="muted small">method v1.1 validation</span>}>
          <div className="two validation">
            <div>
              <img className="placebo" src={`reports/${id}/placebo_test.png`} alt="placebo test histogram" />
              <p className="small muted">
                The same polygon, randomly rotated and dropped {report.validation.placeboCount} times across the surrounding 5 km, analysed exactly like the project. The best random copy gained{" "}
                {report.validation.placeboNetGainMax >= 0 ? "+" : ""}
                {report.validation.placeboNetGainMax.toFixed(3)}; this project {(r.netGain as number) >= 0 ? "+" : ""}
                {(r.netGain as number).toFixed(3)}.
              </p>
            </div>
            <table className="kv">
              <tbody>
                <tr>
                  <td>Placebo p-value (project beats random land)</td>
                  <td>{report.validation.placeboPValue.toFixed(3)}</td>
                </tr>
                <tr>
                  <td>Random land that would pass the gain threshold alone</td>
                  <td>{pct(report.validation.placeboFalsePositiveRate)}</td>
                </tr>
                {Object.entries(report.validation.boundaryNetGain).map(([k, g]) => (
                  <tr key={k}>
                    <td>Boundary {k.replace(/(\d+)m$/, " $1 m").replace("shift", "shifted ").replace("erode", "shrunk").replace("dilate", "grown")}</td>
                    <td>
                      {g >= 0 ? "+" : ""}
                      {g.toFixed(3)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    New canopy still green in the dry season
                    {report.data.drySeason ? ` (${months(report.data.drySeason.months)} ${report.data.drySeason.year})` : ""}
                  </td>
                  <td>{pct(report.validation.drySeasonPersistence)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="two">
        <Card title="Credit calculation">
          <table className="kv">
            <tbody>
              <tr>
                <td>Polygon area</td>
                <td>{report.project.areaHa} ha</td>
              </tr>
              <tr>
                <td>Canopy share (NDVI ≥ {report.params.canopy_ndvi})</td>
                <td>
                  {pct(r.canopyFracBaseline)} → {pct(r.canopyFracMonitoring)} <span className="muted">(control {pct(r.controlCanopyFracBaseline)} → {pct(r.controlCanopyFracMonitoring)})</span>
                </td>
              </tr>
              <tr>
                <td>Additional canopy beyond control trend</td>
                <td>{r.additionalCanopyHa} ha</td>
              </tr>
              <tr>
                <td>Removal factor × years</td>
                <td>
                  {report.params.removal_tco2_ha_yr} tCO2e/ha/yr × {r.years}
                </td>
              </tr>
              <tr>
                <td>Uncertainty deduction (scene-pair spread)</td>
                <td>−{pct(r.uncertaintyDeduction)}</td>
              </tr>
              <tr className="total">
                <td>Creditable removals</td>
                <td>{nf.format(r.creditTonnes)} tCO2e</td>
              </tr>
              <tr>
                <td>of which buffer pool (20%, cancelled on reversal)</td>
                <td>{nf.format(Math.ceil(r.creditTonnes * 0.2))} t</td>
              </tr>
            </tbody>
          </table>
        </Card>

        <Card title="Signed attestation" right={signed && <Badge tone="info">{signed.signatures.length} of {deployment!.oracles.length} oracles</Badge>}>
          <table className="kv">
            <tbody>
              <tr>
                <td>Report hash</td>
                <td>
                  <Hash value={report.reportHash} href={`reports/${id}/report.json`} />
                </td>
              </tr>
              <tr>
                <td>Polygon hash</td>
                <td>
                  <Hash value={report.project.geometryHash} />
                </td>
              </tr>
              <tr>
                <td>Method</td>
                <td>{report.method}</td>
              </tr>
              <tr>
                <td>Signers</td>
                <td className="mono small">{signed?.signers.map((s) => <div key={s}>{short(s)}</div>)}</td>
              </tr>
              <tr>
                <td>Scenes</td>
                <td className="small">
                  {report.data.baseline.scenes.length} baseline ({months(report.data.baseline.months)} {report.data.baseline.year}), {report.data.monitoring.scenes.length} monitoring
                </td>
              </tr>
            </tbody>
          </table>
          {pv?.outcome === undefined ? (
            <button className="btn primary wide" disabled={busy || !signer} onClick={submit} data-testid="submit-attestation">
              {busy ? <Spinner /> : null} Submit attestation to the contract
            </button>
          ) : pv.outcome === 1 && batch ? (
            <div className="issued" data-testid="issued">
              <div>
                <b>Batch #{String(pv.batches[pv.batches.length - 1])}</b> · vintage {String(batch.vintage)}
              </div>
              <div className="mono small">
                {serialLabel(batch.vintage, pv.projectId, batch.serialStart)} → {serialLabel(batch.vintage, pv.projectId, batch.serialStart + batch.issued + batch.buffer - 1n)}
              </div>
              <div className="small muted">
                {nf.format(Number(batch.issued))} t to developer · {nf.format(Number(batch.buffer))} t buffer pool
              </div>
              <a className="btn" href="#/portfolio">
                Trade or retire these credits →
              </a>
            </div>
          ) : (
            <div className="rejected" data-testid="rejected">
              Rejected on-chain. No credits exist for this claim, and the rejection is public and permanent.
            </div>
          )}
          {lastTx && (
            <div className="small muted">
              tx <Hash value={lastTx} href={explorerTx(chainId, lastTx)} />
            </div>
          )}
        </Card>
      </div>
      <Card title="Data provenance">
        <div className="scenes">
          {[...report.data.baseline.scenes.map((s) => ({ ...s, w: "baseline" })), ...report.data.monitoring.scenes.map((s) => ({ ...s, w: "monitoring" }))].map((s) => (
            <div key={s.id} className="scene">
              <span className={`dot ${s.w}`} />
              <span className="mono small">{s.id}</span>
              <span className="muted small">{s.datetime.slice(0, 10)}</span>
              <span className="muted small">{Math.round(s.projectClearFraction * 100)}% clear</span>
            </div>
          ))}
        </div>
        <p className="muted small">Every scene ID resolves to public imagery in the Copernicus Sentinel-2 L2A archive on AWS Open Data. Anyone can re-run the method and must reproduce the signed report hash.</p>
      </Card>
    </div>
  );
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const months = (m: number[]) => m.map((x) => MONTHS[x - 1]).join("–");

// ------------------------------------------------------------------------------------------- portfolio

type Holding = { batchId: bigint; projectId: bigint; vintage: bigint; balance: bigint; serialStart: bigint; issued: bigint; retired: bigint; name: string };

export function Portfolio() {
  const { read, account, signer, refresh, toast, demo, provider, persona, deployment } = useApp();
  const holdings = useChain<Holding[]>(async () => {
    if (!account) return [];
    const n = Number(await read!.batchCount());
    const out: Holding[] = [];
    for (let i = 1; i <= n; i++) {
      const [b, bal] = await Promise.all([read!.getBatch(i), read!.balanceOf(account, i)]);
      const p = await read!.getProject(b.projectId);
      out.push({ batchId: BigInt(i), projectId: b.projectId, vintage: b.vintage, balance: bal, serialStart: b.serialStart, issued: b.issued, retired: b.retired, name: p.name });
    }
    return out;
  }, [account]);
  const [amount, setAmount] = useState("120");
  const [beneficiary, setBeneficiary] = useState("Acme Steel Ltd");
  const [purpose, setPurpose] = useState("FY2026 Scope 1 emissions, Pune plant");
  const [xfer, setXfer] = useState("250");
  const [busy, setBusy] = useState<string>();
  const buyer = demo && provider ? demoWallet(1, provider).address : "";
  const personaLabel = DEMO_PERSONAS.find((p) => p.key === persona)?.label;

  const run = async (key: string, f: (c: Contract) => Promise<{ hash: string; wait: () => Promise<unknown> }>, ok: string, after?: (rcpt: unknown) => void) => {
    if (!signer || !deployment) return;
    const c = pofContract(deployment.address, signer);
    setBusy(key);
    try {
      const tx = await f(c);
      const rc = await tx.wait();
      toast(ok);
      refresh();
      after?.(rc);
    } catch (e) {
      toast(decodeError(e, c), "err");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="page">
      <h1 className="h1-sm">Portfolio</h1>
      <p className="muted">
        Holdings of {demo ? <b>{personaLabel}</b> : "your wallet"} <span className="mono small">{short(account)}</span>. Credits are ERC-1155 tokens: tradable until retired, then burned with their serial numbers assigned to the
        beneficiary.
      </p>
      {!holdings ? (
        <Spinner />
      ) : holdings.filter((h) => h.balance > 0n).length === 0 ? (
        <Card>
          <p className="muted">No credits held by this account yet.{demo && persona !== "developer" ? " Switch to the project developer persona, or have the developer transfer some credits." : ""}</p>
        </Card>
      ) : (
        holdings
          .filter((h) => h.balance > 0n)
          .map((h) => (
            <Card key={String(h.batchId)} title={`${h.name}`} right={<Badge tone="good">{nf.format(Number(h.balance))} tCO2e</Badge>}>
              <div className="hold-meta">
                <span>Batch #{String(h.batchId)}</span>
                <span>Vintage {String(h.vintage)}</span>
                <span className="mono">next serial {serialLabel(h.vintage, h.projectId, h.serialStart + h.retired)}</span>
                <span>{nf.format(Number(h.retired))} of {nf.format(Number(h.issued))} retired so far</span>
              </div>
              <div className="forms">
                {demo && persona === "developer" && (
                  <div className="form">
                    <h4>Sell to Acme Steel Ltd</h4>
                    <label>
                      Amount (t)
                      <input value={xfer} onChange={(e) => setXfer(e.target.value)} data-testid="xfer-amount" />
                    </label>
                    <button
                      className="btn"
                      disabled={!!busy}
                      data-testid="xfer"
                      onClick={() => run("x", (c) => c.safeTransferFrom(account, buyer, h.batchId, BigInt(xfer || "0"), "0x"), `Transferred ${xfer} t to Acme Steel Ltd`)}
                    >
                      {busy === "x" && <Spinner />} Transfer
                    </button>
                  </div>
                )}
                <div className="form">
                  <h4>Retire credits</h4>
                  <label>
                    Amount (t)
                    <input value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="retire-amount" />
                  </label>
                  <label>
                    Beneficiary
                    <input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} data-testid="retire-beneficiary" />
                  </label>
                  <label>
                    Purpose
                    <input value={purpose} onChange={(e) => setPurpose(e.target.value)} />
                  </label>
                  <button
                    className="btn primary"
                    disabled={!!busy}
                    data-testid="retire"
                    onClick={() =>
                      run("r", (c) => c.retire(h.batchId, BigInt(amount || "0"), beneficiary, purpose), `Retired ${amount} t. Certificate issued.`, async () => {
                        const n = await read!.retirementCount();
                        location.hash = `#/certificate/${n}`;
                      })
                    }
                  >
                    {busy === "r" && <Spinner />} Retire &amp; burn
                  </button>
                </div>
              </div>
            </Card>
          ))
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- certificate

export function Certificate({ id }: { id: string }) {
  const { read, deployment, chainId } = useApp();
  const data = useChain(async () => {
    const r = await read!.getRetirement(id);
    const b = await read!.getBatch(r.batchId);
    const p = await read!.getProject(b.projectId);
    return { r, b, p };
  }, [id]);
  const caseId = deployment?.cases.find((c) => data && BigInt(c.projectId) === data.b.projectId)?.id;
  if (!data) return <div className="page">Loading certificate…</div>;
  const { r, b, p } = data;
  const n = Number(BigInt(r.serialTo) - BigInt(r.serialFrom) + 1n);
  return (
    <div className="page">
      <div className="cert" data-testid="certificate">
        <div className="cert-head">
          <div className="logo-mark big" />
          <div>
            <div className="eyebrow">ProofOfForest · Retirement certificate #{id}</div>
            <h1 className="h1-sm">{nf.format(n)} tonnes CO2e permanently retired</h1>
          </div>
        </div>
        <div className="cert-grid">
          <div>
            <span>Beneficiary</span>
            <b>{r.beneficiary}</b>
          </div>
          <div>
            <span>Purpose</span>
            <b>{r.purpose || "—"}</b>
          </div>
          <div>
            <span>Project</span>
            <b>
              #{String(b.projectId)} {p.name}
            </b>
          </div>
          <div>
            <span>Vintage</span>
            <b>{String(b.vintage)}</b>
          </div>
          <div className="span2">
            <span>Serial numbers</span>
            <b className="mono">
              {serialLabel(b.vintage, b.projectId, r.serialFrom)} → {serialLabel(b.vintage, b.projectId, r.serialTo)}
            </b>
          </div>
          <div>
            <span>Retired by</span>
            <b className="mono">{short(r.retiree, 8)}</b>
          </div>
          <div>
            <span>Date</span>
            <b>{new Date(Number(r.timestamp) * 1000).toUTCString().slice(5, 22)} UTC</b>
          </div>
          <div className="span2">
            <span>Satellite verification report</span>
            <b>
              <Hash value={b.reportHash} href={caseId ? `reports/${caseId}/report.json` : undefined} />
            </b>
          </div>
        </div>
        {caseId && (
          <div className="cert-img">
            <img src={`reports/${caseId}/zoom_baseline_rgb.png`} alt="before" />
            <img src={`reports/${caseId}/zoom_monitoring_rgb.png`} alt="after" />
          </div>
        )}
        <p className="muted small">
          The tokens behind these serials were burned in the same transaction that created this record. The contract never re-issues a serial, so this tonne cannot be sold or claimed again. Verify any serial in the{" "}
          <a href="#/explorer">explorer</a>. Contract <Hash value={deployment!.address} href={NETWORKS[chainId]?.explorer ? `${NETWORKS[chainId].explorer}/address/${deployment!.address}` : undefined} />
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- explorer

export function Explorer() {
  const { read } = useApp();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ status: number; batchId: bigint; retirementId: bigint; label?: string } | null>(null);
  const ledger = useChain(async () => {
    const n = Number(await read!.retirementCount());
    const rows = [];
    for (let i = n; i >= 1; i--) {
      const r = await read!.getRetirement(i);
      const b = await read!.getBatch(r.batchId);
      rows.push({ i, r, b });
    }
    const vn = Number(await read!.verificationCount());
    const vs = [];
    for (let i = vn - 1; i >= 0; i--) vs.push({ i, v: await read!.getVerification(i), p: await read!.getProject((await read!.getVerification(i)).projectId) });
    return { rows, vs };
  });
  const lookup = async () => {
    const m = q.trim().match(/(\d+)\s*$/);
    if (!m) return;
    const serial = BigInt(m[1]);
    const [status, batchId, retirementId] = await read!.serialInfo(serial);
    let label;
    if (batchId > 0n) {
      const b = await read!.getBatch(batchId);
      label = serialLabel(b.vintage, b.projectId, serial);
    }
    setRes({ status: Number(status), batchId, retirementId, label });
  };
  return (
    <div className="page">
      <h1 className="h1-sm">Public explorer</h1>
      <Card title="Look up a serial number">
        <div className="lookup">
          <input placeholder="e.g. POF-2025-P001-0000042 or 42" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && lookup()} data-testid="serial-input" />
          <button className="btn primary" onClick={lookup} data-testid="serial-lookup">
            Check
          </button>
        </div>
        {res && (
          <div className={`serial-res s${res.status}`} data-testid="serial-result">
            <b>{res.label ?? q}</b>: {SERIAL_STATUS[res.status]}
            {res.status === 2 && (
              <>
                {" "}
                in <a href={`#/certificate/${res.retirementId}`}>certificate #{String(res.retirementId)}</a>
              </>
            )}
            {res.batchId > 0n && <span className="muted"> · batch #{String(res.batchId)}</span>}
          </div>
        )}
      </Card>
      <div className="two">
        <Card title="Retirement ledger">
          {!ledger?.rows.length ? (
            <p className="muted">No retirements yet.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Beneficiary</th>
                  <th>Serials</th>
                  <th>t</th>
                </tr>
              </thead>
              <tbody>
                {ledger.rows.map(({ i, r, b }) => (
                  <tr key={i} onClick={() => (location.hash = `#/certificate/${i}`)}>
                    <td>{i}</td>
                    <td>{r.beneficiary}</td>
                    <td className="mono small">
                      {serialLabel(b.vintage, b.projectId, r.serialFrom).slice(-7)}–{String(r.serialTo).padStart(7, "0")}
                    </td>
                    <td>{String(BigInt(r.serialTo) - BigInt(r.serialFrom) + 1n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Verification ledger">
          {!ledger?.vs.length ? (
            <p className="muted">No verifications submitted yet.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Net gain</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {ledger.vs.map(({ i, v, p }) => (
                  <tr key={i}>
                    <td>{p.name}</td>
                    <td className={Number(v.netGain) >= 500 ? "good" : "bad"}>
                      {Number(v.netGain) >= 0 ? "+" : ""}
                      {(Number(v.netGain) / 10000).toFixed(3)}
                    </td>
                    <td>{Number(v.outcome) === 1 ? <Badge tone="good">Issued {String(v.creditTonnes)} t</Badge> : <Badge tone="bad">{OUTCOME[Number(v.outcome)]}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- how it works

export function HowItWorks() {
  return (
    <div className="page">
      <h1 className="h1-sm">How ProofOfForest works</h1>
      <div className="arch">
        <img src="architecture.svg" alt="ProofOfForest architecture" />
      </div>
      <div className="grid3 steps">
        <Card title="1 · Measure">
          <p>
            For the project polygon and a <b>control ring</b> 300–1500 m around it, the engine reads only the needed pixels of every Sentinel-2 L2A scene in the same season of the baseline and monitoring years, masks clouds,
            shadows and water with the Scene Classification Layer, and builds per-pixel median NDVI composites.
          </p>
        </Card>
        <Card title="2 · Attribute">
          <p>
            <b>Difference-in-differences</b>: project NDVI change minus control NDVI change. Rain, irrigation and sensor effects hit both and cancel. Robustness is checked across every baseline × monitoring scene pair, and
            credits are cut by the measured uncertainty. Then it tries to prove itself wrong: a <b>placebo test</b> against 200 random copies of the polygon nearby, 20 m <b>boundary shifts</b>, and a{" "}
            <b>dry-season check</b> so only woody canopy counts, not grass or crops.
          </p>
        </Card>
        <Card title="3 · Attest & settle">
          <p>
            Independent oracles each <b>re-run the whole analysis from raw ESA data</b>, refuse unless every number matches, and sign an <b>EIP-712</b> attestation. The contract needs 2 of 3 signatures, re-checks the numbers against its own policy, mints numbered ERC-1155 credits,
            holds 20% in a buffer pool, and burns credits on retirement.
          </p>
        </Card>
      </div>
    </div>
  );
}
