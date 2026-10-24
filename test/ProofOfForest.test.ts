import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ATTESTATION_TYPES, REVERSAL_TYPES, Attestation, domainOf, geom, report, signSorted } from "./helpers";

const Outcome = { None: 0, Issued: 1, RejectedByOracle: 2, RejectedLowGain: 3, RejectedLowCoverage: 4, RejectedNoCredits: 5 };
const Serial = { Nonexistent: 0, Outstanding: 1, Retired: 2, Buffer: 3, Cancelled: 4 };

async function deploy() {
  const [admin, developer, buyer, relayer, o1, o2, o3, outsider] = await ethers.getSigners();
  const F = await ethers.getContractFactory("ProofOfForest");
  const pof = await F.deploy(admin.address, [o1.address, o2.address, o3.address], 2, "ipfs://pof/{id}.json");
  const domain = await domainOf(pof);
  await pof.connect(developer).registerProject("Kutch Mangrove Restoration", geom("polygon-A"), 2019, "ipfs://meta-A");
  const oracles = [o1, o2, o3];
  return { pof, domain, admin, developer, buyer, relayer, oracles, outsider };
}

async function attestation(overrides: Partial<Attestation> = {}): Promise<Attestation> {
  return {
    projectId: 1n,
    geometryHash: geom("polygon-A"),
    reportHash: report("A-2019-2025"),
    baselineYear: 2019,
    monitoringYear: 2025,
    ndviBaseline: 1210,
    ndviMonitoring: 3480,
    controlDelta: 150,
    netGain: 2120,
    validCoverageBps: 9600,
    canopyGainHa100: 4250,
    creditTonnes: 1000n,
    passed: true,
    expiry: BigInt((await time.latest()) + 3600),
    ...overrides,
  };
}

describe("ProofOfForest", () => {
  describe("deployment & policy", () => {
    it("stores the default policy and oracle roles", async () => {
      const { pof, oracles, outsider } = await loadFixture(deploy);
      expect(await pof.oracleThreshold()).to.equal(2);
      expect(await pof.minNetGain()).to.equal(500);
      expect(await pof.minCoverageBps()).to.equal(8000);
      expect(await pof.bufferBps()).to.equal(2000);
      const role = await pof.ORACLE_ROLE();
      for (const o of oracles) expect(await pof.hasRole(role, o.address)).to.equal(true);
      expect(await pof.hasRole(role, outsider.address)).to.equal(false);
    });

    it("only the policy role can change policy, and nonsense policies are rejected", async () => {
      const { pof, admin, outsider } = await loadFixture(deploy);
      await expect(pof.connect(outsider).setPolicy(1, 500, 8000, 2000)).to.be.revertedWithCustomError(pof, "AccessControlUnauthorizedAccount");
      await expect(pof.connect(admin).setPolicy(0, 500, 8000, 2000)).to.be.revertedWithCustomError(pof, "InvalidPolicy");
      await expect(pof.connect(admin).setPolicy(2, 0, 8000, 2000)).to.be.revertedWithCustomError(pof, "InvalidPolicy");
      await expect(pof.connect(admin).setPolicy(2, 500, 10001, 2000)).to.be.revertedWithCustomError(pof, "InvalidPolicy");
      await expect(pof.connect(admin).setPolicy(2, 500, 8000, 10000)).to.be.revertedWithCustomError(pof, "InvalidPolicy");
      await expect(pof.connect(admin).setPolicy(3, 800, 9000, 1500)).to.emit(pof, "PolicyUpdated").withArgs(3, 800, 9000, 1500);
    });
  });

  describe("project registry", () => {
    it("registers a project with a locked polygon hash and baseline year", async () => {
      const { pof, developer } = await loadFixture(deploy);
      const p = await pof.getProject(1);
      expect(p.developer).to.equal(developer.address);
      expect(p.geometryHash).to.equal(geom("polygon-A"));
      expect(p.startYear).to.equal(2019);
      expect(p.lastMonitoringYear).to.equal(2019);
      expect(await pof.projectCount()).to.equal(1);
    });

    it("refuses to register the same land twice (double issuance across projects)", async () => {
      const { pof, outsider } = await loadFixture(deploy);
      await expect(pof.connect(outsider).registerProject("Copycat", geom("polygon-A"), 2019, ""))
        .to.be.revertedWithCustomError(pof, "GeometryAlreadyRegistered")
        .withArgs(1);
    });

    it("rejects an empty geometry or a pre-Sentinel-2 baseline", async () => {
      const { pof, outsider } = await loadFixture(deploy);
      await expect(pof.connect(outsider).registerProject("x", ethers.ZeroHash, 2019, "")).to.be.revertedWithCustomError(pof, "InvalidCreditingPeriod");
      await expect(pof.connect(outsider).registerProject("x", geom("B"), 2010, "")).to.be.revertedWithCustomError(pof, "InvalidCreditingPeriod");
    });

    it("reverts on unknown project ids", async () => {
      const { pof } = await loadFixture(deploy);
      await expect(pof.getProject(0)).to.be.revertedWithCustomError(pof, "UnknownProject");
      await expect(pof.getProject(2)).to.be.revertedWithCustomError(pof, "UnknownProject");
    });
  });

  describe("issuance", () => {
    it("mints credits to the developer only after a 2-of-3 oracle attestation passes", async () => {
      const { pof, domain, developer, relayer, oracles } = await loadFixture(deploy);
      const a = await attestation();
      const sigs = await signSorted(domain, ATTESTATION_TYPES, a, oracles.slice(0, 2));
      await expect(pof.connect(relayer).submitVerification(a, sigs))
        .to.emit(pof, "CreditsIssued")
        .withArgs(1, 1, 2025, 1, 800, 200)
        .and.to.emit(pof, "VerificationRecorded")
        .withArgs(1, 0, a.reportHash, Outcome.Issued, 2120, 1000);
      expect(await pof.balanceOf(developer.address, 1)).to.equal(800);
      expect(await pof.balanceOf(relayer.address, 1)).to.equal(0); // relayer gets nothing
      const b = await pof.getBatch(1);
      expect(b.serialStart).to.equal(1);
      expect(b.issued).to.equal(800);
      expect(b.buffer).to.equal(200);
      expect(b.vintage).to.equal(2025);
      expect(await pof.nextSerial()).to.equal(1001);
      const p = await pof.getProject(1);
      expect(p.lastMonitoringYear).to.equal(2025);
      expect(p.totalIssued).to.equal(800);
      expect(p.totalBuffer).to.equal(200);
    });

    it("accepts all three oracles too (more than threshold)", async () => {
      const { pof, domain, oracles } = await loadFixture(deploy);
      const a = await attestation();
      await expect(pof.submitVerification(a, await signSorted(domain, ATTESTATION_TYPES, a, oracles))).to.emit(pof, "CreditsIssued");
    });

    it("rounds the buffer up so the pool is never under-funded", async () => {
      const { pof, domain, oracles } = await loadFixture(deploy);
      const a = await attestation({ creditTonnes: 7n }); // 20% of 7 = 1.4 -> 2
      await pof.submitVerification(a, await signSorted(domain, ATTESTATION_TYPES, a, oracles.slice(0, 2)));
      const b = await pof.getBatch(1);
      expect(b.buffer).to.equal(2);
      expect(b.issued).to.equal(5);
    });

    it("records an oracle rejection permanently on-chain and mints nothing", async () => {
      const { pof, domain, developer, oracles } = await loadFixture(deploy);
      const a = await attestation({ passed: false, netGain: -310, ndviMonitoring: 1100, creditTonnes: 0n });
      await expect(pof.submitVerification(a, await signSorted(domain, ATTESTATION_TYPES, a, oracles.slice(0, 2))))
        .to.emit(pof, "VerificationRecorded")
        .withArgs(1, 0, a.reportHash, Outcome.RejectedByOracle, -310, 0)
        .and.not.to.emit(pof, "CreditsIssued");
      expect(await pof.balanceOf(developer.address, 1)).to.equal(0);
      expect((await pof.getProject(1)).rejections).to.equal(1);
      expect((await pof.getProject(1)).lastMonitoringYear).to.equal(2019); // period not consumed
      expect(await pof.projectVerifications(1)).to.deep.equal([0n]);
    });

    it("re-checks attested numbers against on-chain policy even if the oracles say 'passed'", async () => {
      const { pof, domain, oracles } = await loadFixture(deploy);
      const lowGain = await attestation({ netGain: 499, reportHash: report("lowgain") });
      await expect(pof.submitVerification(lowGain, await signSorted(domain, ATTESTATION_TYPES, lowGain, oracles.slice(0, 2))))
        .to.emit(pof, "VerificationRecorded")
        .withArgs(1, 0, lowGain.reportHash, Outcome.RejectedLowGain, 499, 1000);
      const lowCov = await attestation({ validCoverageBps: 7999, reportHash: report("lowcov") });
      await expect(pof.submitVerification(lowCov, await signSorted(domain, ATTESTATION_TYPES, lowCov, oracles.slice(0, 2))))
        .to.emit(pof, "VerificationRecorded")
        .withArgs(1, 1, lowCov.reportHash, Outcome.RejectedLowCoverage, 2120, 1000);
      const zero = await attestation({ creditTonnes: 0n, reportHash: report("zero") });
      await expect(pof.submitVerification(zero, await signSorted(domain, ATTESTATION_TYPES, zero, oracles.slice(0, 2))))
        .to.emit(pof, "VerificationRecorded")
        .withArgs(1, 2, zero.reportHash, Outcome.RejectedNoCredits, 2120, 0);
      expect(await pof.batchCount()).to.equal(0);
      expect((await pof.getProject(1)).rejections).to.equal(3);
    });

    it("rejects a single oracle when the threshold is 2", async () => {
      const { pof, domain, oracles } = await loadFixture(deploy);
      const a = await attestation();
      await expect(pof.submitVerification(a, await signSorted(domain, ATTESTATION_TYPES, a, [oracles[0]])))
        .to.be.revertedWithCustomError(pof, "NotEnoughOracleSignatures")
        .withArgs(1, 2);
    });

    it("rejects the same oracle signing twice (duplicate signatures)", async () => {
      const { pof, domain, oracles } = await loadFixture(deploy);
      const a = await attestation();
      const [s] = await signSorted(domain, ATTESTATION_TYPES, a, [oracles[0]]);
      await expect(pof.submitVerification(a, [s, s])).to.be.revertedWithCustomError(pof, "SignersNotSorted");
    });

    it("rejects signatures from addresses that are not oracles", async () => {
      const { pof, domain, oracles, outsider } = await loadFixture(deploy);
      const a = await attestation();
      await expect(pof.submitVerification(a, await signSorted(domain, ATTESTATION_TYPES, a, [oracles[0], outsider])))
        .to.be.revertedWithCustomError(pof, "SignerNotOracle")
        .withArgs(outsider.address);
    });

    it("rejects a tampered attestation (developer inflates credits after signing)", async () => {
      const { pof, domain, oracles } = await loadFixture(deploy);
      const a = await attestation();
      const sigs = await signSorted(domain, ATTESTATION_TYPES, a, oracles.slice(0, 2));
      await expect(pof.submitVerification({ ...a, creditTonnes: 1_000_000n }, sigs)).to.be.revertedWithCustomError(pof, "SignerNotOracle");
      await expect(pof.submitVerification({ ...a, passed: true, netGain: 9999 }, sigs)).to.be.revertedWithCustomError(pof, "SignerNotOracle");
    });

    it("rejects signatures made for another chain or contract (EIP-712 domain separation)", async () => {
      const { pof, domain, oracles } = await loadFixture(deploy);
      const a = await attestation();
      const wrongChain = await signSorted({ ...domain, chainId: 1n }, ATTESTATION_TYPES, a, oracles.slice(0, 2));
      await expect(pof.submitVerification(a, wrongChain)).to.be.revertedWithCustomError(pof, "SignerNotOracle");
      const wrongContract = await signSorted({ ...domain, verifyingContract: ethers.ZeroAddress.replace(/0$/, "1") }, ATTESTATION_TYPES, a, oracles.slice(0, 2));
      await expect(pof.submitVerification(a, wrongContract)).to.be.revertedWithCustomError(pof, "SignerNotOracle");
    });

    it("off-chain digest matches the contract's hashAttestation", async () => {
      const { pof, domain } = await loadFixture(deploy);
      const a = await attestation();
      expect(await pof.hashAttestation(a)).to.equal(ethers.TypedDataEncoder.hash(domain, ATTESTATION_TYPES, a));
    });

    it("prevents replaying a report", async () => {
      const { pof, domain, oracles, admin } = await loadFixture(deploy);
      const a = await attestation();
      const sigs = await signSorted(domain, ATTESTATION_TYPES, a, oracles.slice(0, 2));
      await pof.submitVerification(a, sigs);
      await expect(pof.submitVerification(a, sigs)).to.be.revertedWithCustomError(pof, "ReportAlreadyUsed");
      // a rejected report can't be replayed either
      const r = await attestation({ passed: false, reportHash: report("rej"), baselineYear: 2025, monitoringYear: 2026 });
      const rs = await signSorted(domain, ATTESTATION_TYPES, r, oracles.slice(0, 2));
      await pof.connect(admin).submitVerification(r, rs);
      await expect(pof.submitVerification(r, rs)).to.be.revertedWithCustomError(pof, "ReportAlreadyUsed");
    });

    it("rejects expired attestations", async () => {
      const { pof, domain, oracles } = await loadFixture(deploy);
      const a = await attestation();
      const sigs = await signSorted(domain, ATTESTATION_TYPES, a, oracles.slice(0, 2));
      await time.increaseTo(a.expiry + 1n);
      await expect(pof.submitVerification(a, sigs)).to.be.revertedWithCustomError(pof, "AttestationExpired");
    });

    it("rejects an attestation for a different polygon", async () => {
      const { pof, domain, oracles } = await loadFixture(deploy);
      const a = await attestation({ geometryHash: geom("someone-elses-forest") });
      await expect(pof.submitVerification(a, await signSorted(domain, ATTESTATION_TYPES, a, oracles.slice(0, 2)))).to.be.revertedWithCustomError(pof, "GeometryMismatch");
    });

    it("forces contiguous, non-overlapping crediting periods (no double counting of the same growth)", async () => {
      const { pof, domain, oracles, developer } = await loadFixture(deploy);
      const cherry = await attestation({ baselineYear: 2020 }); // baseline must be the registered 2019
      await expect(pof.submitVerification(cherry, await signSorted(domain, ATTESTATION_TYPES, cherry, oracles.slice(0, 2)))).to.be.revertedWithCustomError(pof, "InvalidCreditingPeriod");
      const backwards = await attestation({ monitoringYear: 2019 });
      await expect(pof.submitVerification(backwards, await signSorted(domain, ATTESTATION_TYPES, backwards, oracles.slice(0, 2)))).to.be.revertedWithCustomError(pof, "InvalidCreditingPeriod");

      const first = await attestation({ monitoringYear: 2022 });
      await pof.submitVerification(first, await signSorted(domain, ATTESTATION_TYPES, first, oracles.slice(0, 2)));
      const overlap = await attestation({ baselineYear: 2019, monitoringYear: 2025, reportHash: report("overlap") });
      await expect(pof.submitVerification(overlap, await signSorted(domain, ATTESTATION_TYPES, overlap, oracles.slice(0, 2)))).to.be.revertedWithCustomError(pof, "InvalidCreditingPeriod");
      const next = await attestation({ baselineYear: 2022, monitoringYear: 2025, reportHash: report("next"), creditTonnes: 500n });
      await pof.submitVerification(next, await signSorted(domain, ATTESTATION_TYPES, next, oracles.slice(0, 2)));
      expect(await pof.projectBatches(1)).to.deep.equal([1n, 2n]);
      expect((await pof.getBatch(2)).serialStart).to.equal(1001);
      expect(await pof.balanceOf(developer.address, 2)).to.equal(400);
    });

    it("pause blocks issuance", async () => {
      const { pof, domain, oracles, admin, outsider } = await loadFixture(deploy);
      await expect(pof.connect(outsider).pause()).to.be.revertedWithCustomError(pof, "AccessControlUnauthorizedAccount");
      await pof.connect(admin).pause();
      const a = await attestation();
      await expect(pof.submitVerification(a, await signSorted(domain, ATTESTATION_TYPES, a, oracles.slice(0, 2)))).to.be.revertedWithCustomError(pof, "EnforcedPause");
      await pof.connect(admin).unpause();
      await expect(pof.submitVerification(a, await signSorted(domain, ATTESTATION_TYPES, a, oracles.slice(0, 2)))).to.emit(pof, "CreditsIssued");
    });
  });

  describe("serials & retirement", () => {
    async function issued() {
      const f = await deploy();
      const a = await attestation();
      await f.pof.submitVerification(a, await signSorted(f.domain, ATTESTATION_TYPES, a, f.oracles.slice(0, 2)));
      return f;
    }

    it("retire() burns credits and assigns a unique serial range to the beneficiary", async () => {
      const { pof, developer } = await loadFixture(issued);
      await expect(pof.connect(developer).retire(1, 100, "Globex Corp", "FY26 Scope 1 offset"))
        .to.emit(pof, "CreditsRetired")
        .withArgs(1, 1, developer.address, 1, 100, "Globex Corp", "FY26 Scope 1 offset");
      expect(await pof.balanceOf(developer.address, 1)).to.equal(700);
      expect(await pof.totalRetired()).to.equal(100);
      const r = await pof.getRetirement(1);
      expect(r.serialFrom).to.equal(1);
      expect(r.serialTo).to.equal(100);
      expect(r.beneficiary).to.equal("Globex Corp");
      expect(r.retiree).to.equal(developer.address);
    });

    it("a retired credit can never be retired or transferred again", async () => {
      const { pof, developer, buyer } = await loadFixture(issued);
      await pof.connect(developer).retire(1, 800, "All", "");
      await expect(pof.connect(developer).retire(1, 1, "Again", "")).to.be.revertedWithCustomError(pof, "ERC1155InsufficientBalance");
      await expect(pof.connect(developer).safeTransferFrom(developer.address, buyer.address, 1, 1, "0x")).to.be.revertedWithCustomError(pof, "ERC1155InsufficientBalance");
    });

    it("credits stay tradable until retired, and the buyer's retirement gets the next serials", async () => {
      const { pof, developer, buyer } = await loadFixture(issued);
      await pof.connect(developer).safeTransferFrom(developer.address, buyer.address, 1, 300, "0x");
      await pof.connect(developer).retire(1, 50, "Dev", "");
      await pof.connect(buyer).retire(1, 250, "Acme Steel Ltd", "CBAM");
      const r = await pof.getRetirement(2);
      expect(r.serialFrom).to.equal(51);
      expect(r.serialTo).to.equal(300);
      await expect(pof.connect(buyer).retire(1, 51, "x", "")).to.be.revertedWithCustomError(pof, "ERC1155InsufficientBalance"); // only 50 left
    });

    it("retireFrom requires operator approval", async () => {
      const { pof, developer, buyer } = await loadFixture(issued);
      await expect(pof.connect(buyer).retireFrom(developer.address, 1, 10, "x", "")).to.be.revertedWithCustomError(pof, "NotAuthorized");
      await pof.connect(developer).setApprovalForAll(buyer.address, true);
      await expect(pof.connect(buyer).retireFrom(developer.address, 1, 10, "Client", "")).to.emit(pof, "CreditsRetired").withArgs(1, 1, developer.address, 1, 10, "Client", "");
    });

    it("rejects zero-amount retirements and unknown batches", async () => {
      const { pof, developer } = await loadFixture(issued);
      await expect(pof.connect(developer).retire(1, 0, "x", "")).to.be.revertedWithCustomError(pof, "InvalidAmount");
      await expect(pof.connect(developer).retire(9, 1, "x", "")).to.be.revertedWithCustomError(pof, "UnknownBatch");
    });

    it("retirement still works while issuance is paused", async () => {
      const { pof, developer, admin } = await loadFixture(issued);
      await pof.connect(admin).pause();
      await expect(pof.connect(developer).retire(1, 5, "x", "")).to.emit(pof, "CreditsRetired");
    });

    it("serialInfo resolves every serial to its batch, status and retirement", async () => {
      const { pof, developer } = await loadFixture(issued);
      await pof.connect(developer).retire(1, 100, "A", "");
      await pof.connect(developer).retire(1, 20, "B", "");
      const check = async (s: number, status: number, batch: number, ret: number) => {
        const [st, b, r] = await pof.serialInfo(s);
        expect([Number(st), Number(b), Number(r)]).to.deep.equal([status, batch, ret]);
      };
      await check(0, Serial.Nonexistent, 0, 0);
      await check(1, Serial.Retired, 1, 1);
      await check(100, Serial.Retired, 1, 1);
      await check(101, Serial.Retired, 1, 2);
      await check(120, Serial.Retired, 1, 2);
      await check(121, Serial.Outstanding, 1, 0);
      await check(800, Serial.Outstanding, 1, 0);
      await check(801, Serial.Buffer, 1, 0);
      await check(1000, Serial.Buffer, 1, 0);
      await check(1001, Serial.Nonexistent, 0, 0);
    });
  });

  describe("permanence (reversals & buffer pool)", () => {
    async function issued() {
      const f = await deploy();
      const a = await attestation();
      await f.pof.submitVerification(a, await signSorted(f.domain, ATTESTATION_TYPES, a, f.oracles.slice(0, 2)));
      return f;
    }
    const reversal = async (lost: bigint, tag = "fire") => ({
      projectId: 1n,
      batchId: 1n,
      reportHash: report(tag),
      lostTonnes: lost,
      expiry: BigInt((await time.latest()) + 3600),
    });

    it("cancels lost tonnes from the buffer without touching holders' credits", async () => {
      const { pof, domain, oracles, developer } = await loadFixture(issued);
      const r = await reversal(150n);
      await expect(pof.recordReversal(r, await signSorted(domain, REVERSAL_TYPES, r, oracles.slice(1))))
        .to.emit(pof, "ReversalRecorded")
        .withArgs(1, 1, r.reportHash, 150, 150, 0);
      expect(await pof.balanceOf(developer.address, 1)).to.equal(800);
      expect((await pof.getBatch(1)).cancelled).to.equal(150);
      const [st] = await pof.serialInfo(801);
      expect(st).to.equal(Serial.Cancelled);
      const [st2] = await pof.serialInfo(951);
      expect(st2).to.equal(Serial.Buffer);
    });

    it("a reversal larger than the buffer records a shortfall that freezes further issuance", async () => {
      const { pof, domain, oracles } = await loadFixture(issued);
      const r = await reversal(260n);
      await expect(pof.recordReversal(r, await signSorted(domain, REVERSAL_TYPES, r, oracles.slice(0, 2))))
        .to.emit(pof, "ReversalRecorded")
        .withArgs(1, 1, r.reportHash, 260, 200, 60);
      expect((await pof.getProject(1)).bufferShortfall).to.equal(60);
      const next = await attestation({ baselineYear: 2025, monitoringYear: 2026, reportHash: report("next") });
      await expect(pof.submitVerification(next, await signSorted(domain, ATTESTATION_TYPES, next, oracles.slice(0, 2)))).to.be.revertedWithCustomError(pof, "ProjectHasBufferShortfall");
    });

    it("reversals also need k-of-n oracle signatures and cannot be replayed", async () => {
      const { pof, domain, oracles, outsider } = await loadFixture(issued);
      const r = await reversal(10n);
      await expect(pof.recordReversal(r, await signSorted(domain, REVERSAL_TYPES, r, [outsider, oracles[0]]))).to.be.revertedWithCustomError(pof, "SignerNotOracle");
      const sigs = await signSorted(domain, REVERSAL_TYPES, r, oracles.slice(0, 2));
      await pof.recordReversal(r, sigs);
      await expect(pof.recordReversal(r, sigs)).to.be.revertedWithCustomError(pof, "ReportAlreadyUsed");
    });
  });

  describe("invariants (randomised)", () => {
    it("serials are never double-assigned and supply always reconciles", async () => {
      const { pof, domain, oracles, developer, buyer, relayer } = await loadFixture(deploy);
      const holders = [developer, buyer, relayer];
      // three consecutive issuances
      const periods: [number, number, bigint][] = [[2019, 2021, 400n], [2021, 2023, 333n], [2023, 2025, 517n]];
      for (const [i, [b, m, t]] of periods.entries()) {
        const a = await attestation({ baselineYear: b, monitoringYear: m, creditTonnes: t, reportHash: report("p" + i) });
        await pof.submitVerification(a, await signSorted(domain, ATTESTATION_TYPES, a, oracles.slice(0, 2)));
      }
      let seed = 42;
      const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
      for (let step = 0; step < 60; step++) {
        const batch = 1 + rnd(3);
        const from = holders[rnd(3)];
        const bal = await pof.balanceOf(from.address, batch);
        if (bal === 0n) continue;
        const amt = BigInt(1 + rnd(Number(bal)));
        if (rnd(2) === 0) {
          const to = holders[rnd(3)];
          if (to.address !== from.address) await pof.connect(from).safeTransferFrom(from.address, to.address, batch, amt, "0x");
        } else {
          await pof.connect(from).retire(batch, amt, "b" + step, "");
        }
      }
      let retiredSum = 0n;
      for (let batch = 1; batch <= 3; batch++) {
        const b = await pof.getBatch(batch);
        const ids = await pof.batchRetirements(batch);
        let cursor = b.serialStart;
        for (const id of ids) {
          const r = await pof.getRetirement(id);
          expect(r.serialFrom).to.equal(cursor); // contiguous, no gaps, no overlaps
          cursor = r.serialTo + 1n;
          retiredSum += r.serialTo - r.serialFrom + 1n;
        }
        expect(cursor - b.serialStart).to.equal(b.retired);
        let held = 0n;
        for (const h of holders) held += await pof.balanceOf(h.address, batch);
        expect(held + b.retired).to.equal(b.issued); // conservation
      }
      expect(await pof.totalRetired()).to.equal(retiredSum);
    });
  });
});
