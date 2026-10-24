/**
 * Deploy ProofOfForest, register the three case-study projects and have the oracle committee sign
 * their verification reports. Writes frontend/public/deployments/<chainId>.json for the dApp.
 *
 *   npx hardhat run scripts/deploy.ts --network amoy        (PRIVATE_KEY in .env)
 *   npx hardhat run scripts/deploy.ts --network localhost   (local demo)
 */
import { ethers, network } from "hardhat";
import { HDNodeWallet, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { attestationFromReport, domainFor, signAttestation } from "../oracle/attestation";

const ROOT = path.resolve(__dirname, "..");
const CASES = ["smritivan-bhuj", "hasdeo-claim", "banni-rain"];
const ORACLE_ENV = path.join(ROOT, ".env.oracles");

function loadOracles(): Wallet[] {
  // Local chain: deterministic, well-known demo keys. Public testnet: keys kept in .env.oracles (git-ignored).
  if (network.name === "hardhat" || network.name === "localhost") {
    const m = "test test test test test test test test test test test junk";
    return [10, 11, 12].map((i) => new Wallet(HDNodeWallet.fromPhrase(m, undefined, `m/44'/60'/0'/0/${i}`).privateKey));
  }
  if (!fs.existsSync(ORACLE_ENV)) {
    const keys = [0, 1, 2].map(() => Wallet.createRandom().privateKey);
    fs.writeFileSync(ORACLE_ENV, `ORACLE_KEYS=${keys.join(",")}\n`, { mode: 0o600 });
    console.log(`Generated 3 oracle keys in ${ORACLE_ENV} (keep this file private, it is git-ignored)`);
  }
  const line = fs.readFileSync(ORACLE_ENV, "utf8").match(/ORACLE_KEYS=(.*)/);
  if (!line) throw new Error(".env.oracles is malformed");
  return line[1].trim().split(",").map((k) => new Wallet(k));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const oracles = loadOracles();
  console.log(`network ${network.name} (chain ${chainId}), deployer ${deployer.address}`);
  console.log(`oracle committee (2-of-3): ${oracles.map((o) => o.address).join(", ")}`);

  const F = await ethers.getContractFactory("ProofOfForest");
  const pof = await F.deploy(deployer.address, oracles.map((o) => o.address), 2, "https://proofofforest.app/api/batch/{id}.json");
  await pof.waitForDeployment();
  const address = await pof.getAddress();
  const deployTx = pof.deploymentTransaction();
  console.log(`ProofOfForest deployed at ${address}`);

  const domain = domainFor(chainId, address);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 60); // 60 days
  const cases = [];
  for (const id of CASES) {
    const project = JSON.parse(fs.readFileSync(path.join(ROOT, "projects", `${id}.json`), "utf8"));
    const reportText = fs.readFileSync(path.join(ROOT, "reports", id, "report.json"), "utf8");
    const report = JSON.parse(reportText);
    const tx = await pof.registerProject(project.name, report.project.geometryHash, project.baseline.year, `reports/${id}/report.json`);
    const rc = await tx.wait();
    const projectId = (await pof.projectByGeometry(report.project.geometryHash)) as bigint;
    const signed = await signAttestation(domain, attestationFromReport(reportText, projectId, expiry), oracles);
    console.log(`  registered #${projectId} ${project.name} (${report.passed ? "PASS" : "REJECT"}) tx ${rc!.hash}`);
    cases.push({ id, projectId: projectId.toString(), registerTx: rc!.hash, ...signed });
  }

  const out = {
    network: network.name,
    chainId: chainId.toString(),
    address,
    deployTx: deployTx?.hash,
    deployer: deployer.address,
    oracles: oracles.map((o) => o.address),
    threshold: 2,
    deployedAt: new Date().toISOString(),
    cases,
  };
  const dir = path.join(ROOT, "frontend", "public", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${chainId}.json`), JSON.stringify(out, null, 2));
  console.log(`wrote frontend/public/deployments/${chainId}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
