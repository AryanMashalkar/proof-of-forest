import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";
import { Wallet } from "ethers";
import { attestationFromReport, domainFor, recomputeReportHash, signAttestation } from "../oracle/attestation";
import { aggregate, signReport } from "../oracle/node";

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

  describe("independent oracle nodes (one key per operator, signature files combined by anyone)", () => {
    it("three operators sign separately, any relayer submits the combined signatures", async () => {
      const { pof, developer, oracles, expiry, buyer } = await setup();
      const text = reportText("smritivan-bhuj");
      const r = JSON.parse(text);
      await pof.connect(developer).registerProject(r.project.name, r.project.geometryHash, r.data.baseline.year, "");
      const projectId = await pof.projectByGeometry(r.project.geometryHash);
      const { chainId } = await ethers.provider.getNetwork();
      const addr = await pof.getAddress();
      const reproduced: string[] = [];
      const files = [];
      for (const key of oracles.slice(1)) {
        files.push(
          await signReport({
            reportText: text, projectId, expiry, chainId, contract: addr, key,
            reproduce: () => (reproduced.push(key.address), null), // stands in for the satellite re-run (network) in CI
            onChainGeometryHash: (await pof.getProject(projectId)).geometryHash,
          }),
        );
      }
      expect(reproduced).to.have.length(2);
      const { attestation, signatures } = aggregate(files, chainId, addr);
      await expect(pof.connect(buyer).submitVerification(attestation, signatures)).to.emit(pof, "CreditsIssued");
    });

    it("a node refuses to sign when its own re-run of the satellite analysis disagrees", async () => {
      const { oracles, expiry } = await setup();
      await expect(
        signReport({ reportText: reportText("smritivan-bhuj"), projectId: 1n, expiry, chainId: 31337n, contract: ethers.ZeroAddress, key: oracles[0], reproduce: () => "results.netGain: report 0.2242 vs recomputed 0.0412" }),
      ).to.be.rejectedWith(/refusing to sign/);
    });

    it("a node refuses to sign for a project registered with a different polygon", async () => {
      const { oracles, expiry } = await setup();
      await expect(
        signReport({ reportText: reportText("smritivan-bhuj"), projectId: 1n, expiry, chainId: 31337n, contract: ethers.ZeroAddress, key: oracles[0], reproduce: () => null, onChainGeometryHash: ethers.ZeroHash }),
      ).to.be.rejectedWith(/registered with geometry/);
    });

    it("signature files for different attestations cannot be combined", async () => {
      const { oracles, expiry } = await setup();
      const text = reportText("smritivan-bhuj");
      const base = { reportText: text, chainId: 31337n, contract: ethers.ZeroAddress, reproduce: () => null };
      const a = await signReport({ ...base, projectId: 1n, expiry, key: oracles[0] });
      const b = await signReport({ ...base, projectId: 1n, expiry: expiry + 1n, key: oracles[1] });
      expect(() => aggregate([a, b], 31337n, ethers.ZeroAddress)).to.throw(/different attestation/);
      const forged = { ...b, attestation: a.attestation, signer: oracles[2].address };
      expect(() => aggregate([a, forged], 31337n, ethers.ZeroAddress)).to.throw(/made by/);
    });
  });
});
