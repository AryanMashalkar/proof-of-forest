/**
 * Independent oracle node. Each committee member runs this on their own machine with their own key:
 *
 *   ORACLE_PRIVATE_KEY=0x… npx ts-node oracle/node.ts sign \
 *       --report reports/smritivan-bhuj/report.json --project-id 1 --expiry 1767225600 \
 *       --chain-id 80002 --contract 0x… [--rpc https://…]
 *
 * Before signing, the node re-runs the whole satellite analysis from the raw Sentinel-2 archive
 * (`python -m pof_engine reproduce`) and refuses unless every number, check and verdict comes out
 * identical. It never signs a report it has only read. It writes one signature file; anyone can then
 * collect the files and submit them:
 *
 *   PRIVATE_KEY=0x… npx ts-node oracle/node.ts submit --report … --chain-id 80002 --contract 0x… --rpc https://…
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { Contract, JsonRpcProvider, Wallet, ethers } from "ethers";
import { ATTESTATION_TYPES, Attestation, attestationFromReport, domainFor } from "./attestation";

export type SignatureFile = { signer: string; signature: string; attestation: Attestation; reproduced: boolean; signedAt: string };

const ROOT = path.resolve(__dirname, "..");
const ABI = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend/src/abi.json"), "utf8"));

/** Re-run the analysis from raw satellite data. Returns null when it matches, else the differences. */
export function reproduceWithEngine(reportPath: string): string | null {
  const py = process.env.PYTHON || "python";
  const r = spawnSync(py, ["-m", "pof_engine", "reproduce", path.resolve(reportPath)], { cwd: path.join(ROOT, "engine"), encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  if (r.status === 0) return null;
  return (r.stdout || "") + (r.stderr || "") || `engine exited with ${r.status}`;
}

export async function signReport(opts: {
  reportText: string;
  projectId: bigint;
  expiry: bigint;
  chainId: bigint;
  contract: string;
  key: Wallet;
  reproduce: () => string | null;
  onChainGeometryHash?: string;
}): Promise<SignatureFile> {
  const a = attestationFromReport(opts.reportText, opts.projectId, opts.expiry); // re-hashes and re-derives every field
  if (opts.onChainGeometryHash && opts.onChainGeometryHash.toLowerCase() !== a.geometryHash.toLowerCase()) {
    throw new Error(`project ${opts.projectId} is registered with geometry ${opts.onChainGeometryHash}, report covers ${a.geometryHash}`);
  }
  const diff = opts.reproduce();
  if (diff !== null) throw new Error(`refusing to sign: independent re-run does not match the report\n${diff}`);
  const signature = await opts.key.signTypedData(domainFor(opts.chainId, opts.contract), ATTESTATION_TYPES, a);
  return { signer: opts.key.address, signature, attestation: a, reproduced: true, signedAt: new Date().toISOString() };
}

/** Combine signature files from different operators: all must sign the identical attestation. */
export function aggregate(files: SignatureFile[], chainId: bigint, contract: string) {
  if (!files.length) throw new Error("no signatures");
  const domain = domainFor(chainId, contract);
  const digest = ethers.TypedDataEncoder.hash(domain, ATTESTATION_TYPES, files[0].attestation);
  const seen = new Map<string, string>();
  for (const f of files) {
    if (ethers.TypedDataEncoder.hash(domain, ATTESTATION_TYPES, f.attestation) !== digest) throw new Error(`${f.signer} signed a different attestation`);
    const rec = ethers.recoverAddress(digest, f.signature);
    if (rec.toLowerCase() !== f.signer.toLowerCase()) throw new Error(`signature in ${f.signer}'s file was made by ${rec}`);
    seen.set(rec.toLowerCase(), f.signature);
  }
  const signers = [...seen.keys()].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
  return { attestation: files[0].attestation, signers, signatures: signers.map((s) => seen.get(s)!) };
}

function arg(name: string, required = true): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (!v && required) throw new Error(`missing --${name}`);
  return v || "";
}

async function main() {
  const cmd = process.argv[2];
  const reportPath = arg("report");
  const chainId = BigInt(arg("chain-id"));
  const contract = ethers.getAddress(arg("contract"));
  const rpc = arg("rpc", false);
  const sigDir = path.join(path.dirname(reportPath), "signatures", `${chainId}-${contract.toLowerCase()}`);
  const provider = rpc ? new JsonRpcProvider(rpc, Number(chainId)) : undefined;

  if (cmd === "sign") {
    const key = new Wallet(process.env.ORACLE_PRIVATE_KEY || "");
    const projectId = BigInt(arg("project-id"));
    const pof = provider ? new Contract(contract, ABI, provider) : undefined;
    if (pof && !(await pof.hasRole(ethers.id("ORACLE_ROLE"), key.address))) throw new Error(`${key.address} is not an oracle of ${contract}`);
    const sf = await signReport({
      reportText: fs.readFileSync(reportPath, "utf8"),
      projectId,
      expiry: BigInt(arg("expiry")),
      chainId,
      contract,
      key,
      reproduce: () => reproduceWithEngine(reportPath),
      onChainGeometryHash: pof ? (await pof.getProject(projectId)).geometryHash : undefined,
    });
    fs.mkdirSync(sigDir, { recursive: true });
    const out = path.join(sigDir, `${key.address.toLowerCase()}.json`);
    fs.writeFileSync(out, JSON.stringify(sf, null, 2));
    console.log(`signed by ${key.address} -> ${out}`);
  } else if (cmd === "submit") {
    if (!provider) throw new Error("submit needs --rpc");
    const files = fs.readdirSync(sigDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(sigDir, f), "utf8")) as SignatureFile);
    const { attestation, signatures, signers } = aggregate(files, chainId, contract);
    const pof = new Contract(contract, ABI, new Wallet(process.env.PRIVATE_KEY || "", provider));
    const t = await pof.oracleThreshold();
    if (signatures.length < Number(t)) throw new Error(`have ${signatures.length} signatures, contract needs ${t}`);
    console.log(`submitting with signatures from ${signers.join(", ")}`);
    const tx = await pof.submitVerification(attestation, signatures);
    console.log(`tx ${tx.hash}`);
    await tx.wait();
    console.log("done");
  } else {
    throw new Error("usage: node.ts sign|submit --report … --chain-id … --contract … [--rpc …]");
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
