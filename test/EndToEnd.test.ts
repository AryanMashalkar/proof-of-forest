import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";
import { Wallet } from "ethers";
import { attestationFromReport, domainFor, recomputeReportHash, signAttestation } from "../oracle/attestation";

// End-to-end on the committed, real Sentinel-2 verification reports.
const reportText = (id: string) => fs.readFileSync(path.join(__dirname, "..", "reports", id, "report.json"), "utf8");

describe("End to end: real Sentinel-2 reports -> oracle committee -> contract", () => {
  async function setup() {
    const [admin, developer, buyer] = await ethers.getSigners();
    const oracles = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
    const pof = await (await ethers.getContractFactory("ProofOfForest")).deploy(admin.address, oracles.map((o) => o.address), 2, "");
    const { chainId } = await ethers.provider.getNetwork();
    const domain = domainFor(chainId, await pof.getAddress());
    const expiry = BigInt((await time.latest()) + 3600);
    const submit = async (id: string) => {
      const text = reportText(id);
      const r = JSON.parse(text);
      await pof.connect(developer).registerProject(r.project.name, r.project.geometryHash, r.data.baseline.year, "");
      const projectId = await pof.projectByGeometry(r.project.geometryHash);
      const s = await signAttestation(domain, attestationFromReport(text, projectId, expiry), oracles.slice(0, 2));
      return { tx: pof.submitVerification(s.attestation, s.signatures), r, projectId };
    };
    return { pof, developer, buyer, submit, oracles, domain, expiry };
  }

  it("Smritivan (real Miyawaki forest) is verified and credits are issued", async () => {
    const { pof, developer, submit } = await setup();
    const { tx, r } = await submit("smritivan-bhuj");
    await expect(tx).to.emit(pof, "CreditsIssued");
    const total = BigInt(r.results.creditTonnes);
    const buffer = (total * 2000n + 9999n) / 10000n;
    expect(await pof.balanceOf(developer.address, 1)).to.equal(total - buffer);
  });

  it("Hasdeo (forest cleared for a mine) is rejected and recorded on-chain", async () => {
    const { pof, submit } = await setup();
    const { tx } = await submit("hasdeo-claim");
    await expect(tx).to.emit(pof, "VerificationRecorded").and.not.to.emit(pof, "CreditsIssued");
    expect((await pof.getVerification(0)).outcome).to.equal(2); // RejectedByOracle
  });

  it("Banni (region-wide rain greening) is rejected even though NDVI rose by +0.48", async () => {
    const { pof, submit } = await setup();
    const { tx, r } = await submit("banni-rain");
    expect(r.results.naiveWouldPass).to.equal(true);
    await expect(tx).to.emit(pof, "VerificationRecorded").and.not.to.emit(pof, "CreditsIssued");
  });

  it("oracles refuse to sign a report whose content was edited", async () => {
    const text = reportText("banni-rain").replace('"passed": false', '"passed": true');
    expect(recomputeReportHash(text)).to.not.equal(JSON.parse(text).reportHash);
    expect(() => attestationFromReport(text, 1n, 0n)).to.throw(/hash mismatch/);
  });
});
