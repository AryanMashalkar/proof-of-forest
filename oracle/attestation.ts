/**
 * Oracle node logic: turn a published verification report into an EIP-712 attestation and sign it.
 *
 * An oracle never signs numbers it has not checked: it recomputes the report hash from the report body
 * (keccak256 of canonical JSON) and re-derives every signed field from the report itself.
 */
import { ethers, Wallet, TypedDataDomain } from "ethers";

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "projectId", type: "uint256" },
    { name: "geometryHash", type: "bytes32" },
    { name: "reportHash", type: "bytes32" },
    { name: "baselineYear", type: "uint16" },
    { name: "monitoringYear", type: "uint16" },
    { name: "ndviBaseline", type: "int32" },
    { name: "ndviMonitoring", type: "int32" },
    { name: "controlDelta", type: "int32" },
    { name: "netGain", type: "int32" },
    { name: "validCoverageBps", type: "uint32" },
    { name: "canopyGainHa100", type: "uint32" },
    { name: "creditTonnes", type: "uint64" },
    { name: "passed", type: "bool" },
    { name: "expiry", type: "uint64" },
  ],
};

export type Attestation = {
  projectId: string;
  geometryHash: string;
  reportHash: string;
  baselineYear: number;
  monitoringYear: number;
  ndviBaseline: number;
  ndviMonitoring: number;
  controlDelta: number;
  netGain: number;
  validCoverageBps: number;
  canopyGainHa100: number;
  creditTonnes: string;
  passed: boolean;
  expiry: string;
};

/** Python's json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number") return pyNumber(v);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

// Python prints floats with a trailing ".0" and uses repr() precision; JSON.parse loses the int/float
// distinction, so the report file is re-read with a parser that keeps the original number text.
function pyNumber(n: number): string {
  return String(n);
}

/** Parse JSON keeping numbers as their literal source text, so hashing is byte-exact with Python. */
export function parseExact(text: string): unknown {
  const marked = text.replace(/("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str, num) =>
    str !== undefined ? str : `{"__num":"${num}"}`,
  );
  const revive = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (Object.keys(o).length === 1 && typeof o.__num === "string") return new RawNumber(o.__num);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) out[k] = revive(o[k]);
      return out;
    }
    return v;
  };
  return revive(JSON.parse(marked));
}

export class RawNumber {
  constructor(public readonly text: string) {}
}

export function canonicalExact(v: unknown): string {
  if (v instanceof RawNumber) return v.text;
  if (v === null || typeof v !== "object") return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => c);
  if (Array.isArray(v)) return "[" + v.map(canonicalExact).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalExact(o[k])).join(",") + "}";
}

/** Recompute keccak256(canonical report body) exactly as the Python engine does. */
export function recomputeReportHash(reportText: string): string {
  const exact = parseExact(reportText) as Record<string, unknown>;
  delete exact.reportHash;
  delete exact.attestation;
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalExact(exact)));
}

const s4 = (x: number) => Math.round(x * 10_000);

/** Derive the signed fields from the report body (never trust the report's own `attestation` block). */
export function attestationFromReport(reportText: string, projectId: bigint, expiry: bigint): Attestation {
  const report = JSON.parse(reportText);
  const hash = recomputeReportHash(reportText);
  if (hash !== report.reportHash) throw new Error(`report hash mismatch: file says ${report.reportHash}, content hashes to ${hash}`);
  const r = report.results;
  const checksPass = report.checks.every((c: { pass: boolean }) => c.pass);
  if (checksPass !== report.passed) throw new Error("report verdict inconsistent with its checks");
  return {
    projectId: projectId.toString(),
    geometryHash: report.project.geometryHash,
    reportHash: report.reportHash,
    baselineYear: report.data.baseline.year,
    monitoringYear: report.data.monitoring.year,
    ndviBaseline: s4(r.projectNdviBaseline),
    ndviMonitoring: s4(r.projectNdviMonitoring),
    controlDelta: s4(r.controlDelta),
    netGain: s4(r.netGain),
    validCoverageBps: Math.round(r.coverage * 10_000),
    canopyGainHa100: Math.round(r.additionalCanopyHa * 100),
    creditTonnes: String(report.passed ? r.creditTonnes : 0),
    passed: report.passed,
    expiry: expiry.toString(),
  };
}

export type SignedAttestation = { attestation: Attestation; signatures: string[]; signers: string[] };

/** Every oracle signs; signatures are returned ordered by ascending signer address, as the contract requires. */
export async function signAttestation(domain: TypedDataDomain, a: Attestation, oracles: Wallet[]): Promise<SignedAttestation> {
  const signed = await Promise.all(oracles.map(async (w) => ({ addr: w.address, sig: await w.signTypedData(domain, ATTESTATION_TYPES, a) })));
  signed.sort((x, y) => (BigInt(x.addr) < BigInt(y.addr) ? -1 : 1));
  return { attestation: a, signatures: signed.map((s) => s.sig), signers: signed.map((s) => s.addr) };
}

export function domainFor(chainId: bigint | number, verifyingContract: string): TypedDataDomain {
  return { name: "ProofOfForest", version: "1", chainId, verifyingContract };
}
