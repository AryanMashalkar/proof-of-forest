# Devpost submission draft: ProofOfForest

> Copy each section into the matching Devpost field.

**Project name:** ProofOfForest

**Tagline (≤ 200 chars):** Carbon credits that exist only if the forest does: Sentinel-2 satellite verification, a 2-of-3 oracle committee, and serial-numbered ERC-1155 credits that can be retired exactly once.

**Track:** Carbon Markets & Emissions Transparency

**Links:** GitHub [github.com/AryanMashalkar/proof-of-forest](https://github.com/AryanMashalkar/proof-of-forest) · Demo video (4:48) · Testnet contract [0x0981c8D03882e5B3D76Ed65adD15D2eb818B8aCa on Ethereum Sepolia](https://sepolia.etherscan.io/address/0x0981c8D03882e5B3D76Ed65adD15D2eb818B8aCa)

---

## Track alignment

The track asks for transparency in carbon markets. ProofOfForest makes the two things buyers can't see today transparent and machine-checkable: **whether the forest behind a credit actually grew**, and **whether that tonne has already been sold or claimed**. Every credit links to public satellite evidence and a signed, reproducible report. Every tonne has a serial number, and its retirement is a permanent on-chain record anyone can look up.

## Inspiration

Investigations into the voluntary carbon market keep finding the same two failures: credits issued for forest growth or protection that did not happen, and tonnes counted more than once. Verification depends on expensive, infrequent site audits that buyers can't inspect and small community projects can't afford. Meanwhile the European Space Agency publishes 10 m imagery of every forest on Earth every five days, for free. We wanted to connect that public evidence directly to the credit itself.

## What it does

1. A developer registers a project: a polygon and a baseline year. The polygon's hash is unique on-chain, so the same land can't be registered twice, and the baseline can't be changed later.
2. Our **verification engine** pulls every Sentinel-2 scene of that place in the same season of the baseline and monitoring years, masks clouds, shadows and water, and builds NDVI (greenness) composites.
3. It compares the project with a **control ring** of land 300–1500 m around it. Only greening beyond the surrounding landscape counts (difference-in-differences). It re-checks the result across every pair of scenes and deducts credits for uncertainty.
4. It then tries to prove itself wrong:
   * **Placebo test:** the same polygon is dropped at 200 random places nearby and analysed identically. The project must beat 95% of them, so a boundary drawn around land that "happened to green" fails.
   * **Boundary sensitivity:** the polygon is shrunk, grown and shifted by 20 m. The gain must survive every variant.
   * **Woody canopy only:** new canopy must stay green through the dry season. Trees do, while grass and crops brown off.
5. Three **independent oracle nodes**, each with its own key, **re-run the whole analysis from the raw ESA archive** and refuse to sign unless every number matches. Anyone can combine their signature files and relay them.
6. The **smart contract** accepts it only with 2 of 3 oracle signatures, then re-checks the numbers against its own policy. If it passes, it mints ERC-1155 credits with a unique serial range and keeps 20% in a buffer pool against future forest loss. If it fails, the rejection is stored on-chain permanently.
7. Buyers trade the credits, then call `retire()`, which burns them and assigns their serial numbers to a named beneficiary. Anyone can look up any serial and see whether it is outstanding, retired (and by whom), or in the buffer.

**Three real case studies, real Sentinel-2 data:**

| Case | Result |
|---|---|
| **Smritivan, Bhuj (Gujarat)**: Miyawaki forest planted on a barren hill after 2019 | NDVI 0.14 → 0.43, control +0.07, **net +0.22**. Beats all 200 placebo polygons (p = 0.005; best random land +0.10), holds under every 20 m boundary shift, 100% of new canopy stays green in the dry season → **541 tCO2e issued** |
| **"Green Hasdeo"**: hypothetical claim on land that was actually cleared for a coal mine | NDVI 0.56 → 0.09, **net −0.48** → **rejected on-chain** |
| **"Banni Regreening"**: hypothetical claim on grassland that greened only because a drought year was followed by a wet monsoon | NDVI **+0.48** inside the polygon, but **+0.48 in the control ring** too, **net +0.006**. No better than random land (placebo p = 0.57), and only 34% of the "new canopy" survives the next dry season (it's grass) → **rejected**, even though a naive before/after check would have issued credits |

All three reports were independently re-run from scratch (empty cache, raw ESA data) with the same command the oracles run, and reproduced exactly.

## How we built it

* **Verification engine (Python):** rasterio windowed reads of Cloud-Optimized GeoTIFFs straight from the public Sentinel-2 L2A archive on AWS Open Data (no API keys), Scene Classification Layer cloud masking, per-pixel median composites, control-ring difference-in-differences, scene-pair robustness (10th percentile), uncertainty deduction, canonical JSON reports hashed with keccak256, evidence images bound by SHA-256.
* **Validation (Python):** placebo test with 200 seeded random polygons, boundary-sensitivity variants, dry-season woody-canopy persistence, and a `reproduce` command that re-runs a published report from raw data and diffs every field.
* **Oracle nodes (TypeScript, ethers v6):** one key per operator; re-run the analysis before signing, byte-exact re-hashing of the Python report, field re-derivation, on-chain polygon check, EIP-712 signature files that anyone can combine (2-of-3, sorted signers) and relay.
* **Smart contract (Solidity 0.8.24, OpenZeppelin 5):** ERC-1155 batches, AccessControl, EIP-712, project registry with unique polygon hashes and locked, contiguous crediting periods, on-chain policy re-check, serial ranges, `retire` / `retireFrom`, `serialInfo` binary-search lookup, buffer pool and reversal handling, issuance-only pause.
* **dApp (React + Vite + ethers):** registry, drag-to-compare satellite evidence (true colour, NDVI, change), oracle verdict with the difference-in-differences chart, one-click attestation submission, portfolio with transfer and retire, retirement certificates, and a public serial and ledger explorer.
* **Quality:** 52 automated tests: 33 contract unit tests including a randomised invariant test (no serial assigned twice, supply always reconciles), 8 end-to-end and oracle-node tests that push the three real satellite reports through independent signers into the contract, and 11 engine tests on synthetic scenes (including seasonal grass, placebo, boundary and reproduction). GitHub Actions CI. One-command local demo (`npm run demo`) and testnet deployment script.

## Challenges we ran into

* **A hidden −0.1 reflectance trap.** Since 2022, Sentinel-2 products carry a +1000 offset. Applying it twice or never makes NDVI trends appear out of nowhere. In our first run, 2025 imagery came out far darker than 2019 and most pixels were wrongly discarded as invalid. The engine now reads each scene's metadata and applies the offset exactly once.
* **Rain looks like reforestation.** A wet year makes everything greener. A simple before/after check would have credited the Banni grasslands. The control ring and difference-in-differences were the fix, and they became the core of the method.
* **Making Python and Solidity agree on a hash.** Oracles must reproduce the report hash byte-for-byte in TypeScript, including float formatting. We wrote an exact-number JSON parser so a report hashes identically in both languages.
* **"Did you just draw the polygon around the green bit?"** A fair question for any remote-sensing claim. Instead of arguing, we made the method answer it: 200 random copies of the polygon nearby, analysed identically. Around Smritivan, random land tops out at +0.10, while the project is +0.22. Around Banni, the "project" is a perfectly ordinary piece of grassland.
* **Double counting under transfers.** Serial numbers on fungible tokens are subtle. We assign serials on retirement from a per-batch cursor, so every tonne gets exactly one serial and one owner of record.

## Accomplishments we're proud of

* It catches the greenwashing case that fools naive verification, on real satellite data, four independent ways.
* It tests itself like a scientist would: a placebo test answers "could a hand-drawn boundary have produced this?" with a p-value.
* Every number in the demo can be reproduced by anyone from public data and checked against an on-chain hash.
* Defence in depth: even if two oracles were compromised, the contract still refuses weak evidence.

## What we learned

Remote sensing is powerful but easy to fool yourself with: season, rainfall and processing changes all move NDVI. Good verification is less about a clever index and more about the right comparison (a control area), robustness checks, and conservative accounting.

## Target users

* **Small reforestation developers** (NGOs, farmer collectives, city forests) who can't afford traditional audits.
* **Corporate buyers** who need climate claims that survive public scrutiny.
* **Registries and auditors** who want a cheap, automatic first screen before a site visit.
* **Journalists, regulators and the public**, who can check any credit's evidence and serial.

## Scalability

Sentinel-2 covers every land surface every five days. The engine reads only each project's pixels (a few MB per scene) and verifies a project in about 90 seconds on a laptop, so thousands of projects can be re-checked every year. That turns verification from a once-every-five-years audit into continuous monitoring, which our reversal and buffer-pool mechanism is designed for. On-chain costs are a few hundred thousand gas per issuance, cents on a layer-2 network.

## Adoption path

1. **Screening tool** for existing registries and buyers: "does this project's land actually look like that?"
2. **Independent oracle committee** run by a registry, an auditor and a university remote-sensing lab.
3. **Interoperability:** ERC-1155 batches with public serials plug into existing on-chain carbon infrastructure and retirement aggregators.

## What's next

Biomass instead of greenness (GEDI canopy height, field plots), automatic rejection of polygons that overlap any registered project, independent oracle operators, and a mainnet layer-2 deployment with multisig and timelock governance.

## Honest limitations

NDVI locates new woody canopy but does not weigh it: tonnes come from a conservative, configurable removal factor (7 tCO2e/ha/yr) rather than field-calibrated allometry. 10 m pixels under-credit very young saplings. The oracle node software is built for independent operators, but in the demo all three nodes run on one laptop. Hasdeo and Banni are hypothetical fraud scenarios on real imagery. Credit figures are method demonstrations, not certified offsets.

## Built with

`solidity` `openzeppelin` `hardhat` `ethers.js` `typescript` `react` `vite` `python` `rasterio` `numpy` `shapely` `pyproj` `sentinel-2` `copernicus` `aws-open-data` `eip-712` `erc-1155` `polygon`
