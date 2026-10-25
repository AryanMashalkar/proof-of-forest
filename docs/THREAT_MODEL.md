# ProofOfForest threat model

ProofOfForest has three trust boundaries: the **measurement** (satellite data and the verification engine), the **attestation** (the oracle committee), and the **settlement** (the `ProofOfForest` contract). This document lists who might attack each, what they would try, and what stops them. Every mitigation marked *(test)* is exercised by an automated test in `test/` or `engine/tests/`.

## Assets

| Asset | Why it matters |
|---|---|
| Integrity of issued credits | A credit must correspond to real, additional, measured carbon removal |
| Uniqueness of each tonne | One tonne must be sold and claimed at most once (no double counting) |
| Retirement records | Buyers rely on them for public climate claims |
| Oracle keys | Two of them can authorise issuance |
| Admin / policy role | Can change thresholds and pause issuance |

## Actors

* **Dishonest project developer**: wants credits for land that did not grow, or more credits than it earned.
* **Opportunistic relayer / front-runner**: watches the mempool for attestations.
* **Compromised or lazy oracle**: one oracle key is stolen, or one node signs without checking.
* **Double-counting buyer or broker**: wants to claim the same tonnes twice or resell retired ones.
* **Malicious admin**: a governance key holder.

## Threats and mitigations

### A. Measurement (fake or exaggerated growth)

| # | Threat | Mitigation |
|---|---|---|
| A1 | Claim reforestation on land that was actually cleared or never planted | NDVI inside the polygon is measured from 10 m Sentinel-2 imagery; net gain must be ≥ +0.05 *(test: clearing rejected; real case "Green Hasdeo" rejected at −0.484)* |
| A2 | Pick a drought baseline and a wet monitoring year so the whole region looks greener ("rain greenwashing") | Difference-in-differences against a 300–1500 m control ring cancels region-wide effects *(test; real case "Banni": +0.48 raw gain, +0.006 net, rejected)* |
| A3 | Compare a leafless season with a leafy one | Baseline and monitoring windows must cover the same calendar months, or the engine refuses to run *(test)* |
| A4 | Hide behind clouds, cloud shadow or haze | Per-pixel Scene Classification Layer mask; ≥ 80% of polygon pixels must have a clear view in both windows *(test: cloudy evidence rejected)* |
| A5 | Cherry-pick one lucky image | Median of up to 6 scenes per window; the gain must also hold at the 10th percentile of all baseline × monitoring scene pairs; credits are cut by the measured spread (10–50% uncertainty deduction) *(test)* |
| A6 | Post-2022 processing baseline shifts reflectance by −0.1 (a classic trap that fakes NDVI trends) | The engine reads each scene's STAC metadata and applies the BOA offset exactly once (`catalog.py`) |
| A7 | Draw the polygon over a neighbour's existing forest, or the control ring over cleared land | Polygon hash is public; existing forest yields no *gain*; a degraded control ring only lowers the control trend modestly, and the ring is 1.2 km wide and published as evidence for review. Future work: land-cover screening of the ring |
| A8 | Register the same land twice under two projects | `projectByGeometry` makes polygon hashes unique *(test)*. Overlapping but non-identical polygons are a known gap: the production oracle should reject polygons that intersect any registered polygon |
| A9 | Credit the same growth twice by re-running the same years | Baseline year is locked at registration; each crediting period must start where the last ended, and periods never overlap *(test)* |
| A10 | Tamper with the published report after it was signed | `reportHash` is keccak256 of the canonical report (including SHA-256 of every evidence image). Oracles recompute it and refuse mismatches *(test)*; anyone can run `python -m pof_engine check-hash` |
| A11 | Pass off seasonal grass or crops as forest | Woody-canopy rule: a pixel only counts as canopy if it stays above NDVI 0.40 in the following dry season, and ≥ 60% of new canopy must persist *(test: seasonal grass rejected; real case Banni: only 34% persists)*. Limitation: NDVI locates canopy but does not weigh biomass; see "Known limitations" |
| A12 | Draw the boundary around whichever pixels happened to green (selection bias) | **Placebo test**: 200 random rotated copies of the same polygon within 5 km, analysed identically; the project must beat 95% of them *(test; Smritivan p = 0.005, Banni p = 0.57)*. **Boundary sensitivity**: gain must hold with the polygon shrunk, grown or shifted by 20 m *(test)*. The polygon hash and baseline year are fixed on-chain at registration, before monitoring. A tighter boundary also *reduces* credited area, because credits scale with canopy hectares, not with the NDVI gain |

### B. Attestation (oracles)

| # | Threat | Mitigation |
|---|---|---|
| B1 | One oracle key is stolen | k-of-n threshold (2-of-3 by default): one key cannot mint *(test)* |
| B2 | The same oracle signature is submitted twice to fake a quorum | Signers must be strictly ascending, so duplicates revert *(test)* |
| B3 | Developer edits a signed attestation (more tonnes, `passed = true`) | EIP-712 signature covers every field; any change recovers a different address and reverts *(test)* |
| B4 | Replay an attestation on another chain or contract | EIP-712 domain binds chainId and verifying contract *(test)* |
| B5 | Replay the same report | `reportUsed[reportHash]` is set on first use, including for rejections *(test)* |
| B6 | Sit on an old attestation and submit it much later | Every attestation carries an `expiry` *(test)* |
| B7 | Colluding or buggy oracles sign weak numbers as "passed" | Defence in depth: the contract re-checks net gain, coverage and credits against its own on-chain policy and records a policy rejection *(test)* |
| B8 | Oracle signs without checking ("rubber-stamping") | The oracle node (`oracle/node.ts`) will not sign until `pof_engine reproduce` has re-run the full analysis from the raw ESA archive and every result, check and verdict matches; it also refuses non-standard method parameters and a polygon that differs from the on-chain registration *(tests)*. All three real reports were reproduced bit-for-bit from an empty cache |
| B9 | Oracle keys all controlled by one party | One key per operator, one signature file per node; anyone combines and relays, and the combiner rejects files that sign different attestations or forged signer names *(tests)*. Committee membership is `ORACLE_ROLE`, changeable only by the admin (production: multisig + timelock) |

### C. Settlement (contract)

| # | Threat | Mitigation |
|---|---|---|
| C1 | Front-runner copies a pending attestation to steal credits | Credits always mint to the registered developer, whoever relays *(test)* |
| C2 | Retire the same tonne twice / sell retired credits | `retire()` burns tokens; the serial cursor only moves forward; burned tokens cannot be transferred *(tests incl. randomised invariant: no serial overlap, supply conservation)* |
| C3 | Broker retires a client's credits without permission | `retireFrom` requires ERC-1155 operator approval *(test)* |
| C4 | Forest later burns or is cleared (non-permanence) | 20% of every issuance is withheld in a buffer pool (rounded up). A 2-of-3 reversal attestation cancels buffer serials; any uncovered loss is recorded as a shortfall that freezes further issuance *(tests)* |
| C5 | Admin pauses to trap holders | `pause()` only stops issuance; retirement is never pausable *(test)* |
| C6 | Admin weakens policy silently | Policy changes emit `PolicyUpdated`; nonsensical policies (zero threshold, zero gain, ≥100% buffer) revert *(test)*. Production: put `DEFAULT_ADMIN_ROLE` and `POLICY_ROLE` behind a multisig and a timelock |
| C7 | Re-entrancy via ERC-1155 receiver hooks | Replay flags, crediting period, serial counter and supply are all updated before `_mint` calls the receiver hook; `retire` only burns (no receiver hook). Compiler 0.8.24 with checked arithmetic |
| C8 | Serial lookup becomes too expensive as history grows | `serialInfo` uses two binary searches: O(log batches + log retirements) |

## Known limitations (stated honestly)

1. **NDVI locates canopy; it does not weigh it.** The method uses NDVI only to decide *where* new, persistent woody canopy exists beyond the landscape trend. Tonnes come from a conservative removal factor (7 tCO2e/ha/yr, configurable per ecozone and recorded in the signed report), then a 10–50% uncertainty deduction and a 20% buffer. Production use would calibrate that factor with field plots and canopy height (GEDI / LiDAR).
2. **10 m resolution** cannot see individual saplings; very young plantations may only become creditable after canopy closes. This errs on the side of under-crediting.
3. **In the demo, all three oracle nodes run on one laptop.** The node software is built for independent operators (each re-runs the analysis, signs with its own key and publishes a signature file), but independence is ultimately a governance property: production needs a registry, an auditor and a research lab each running a node.
4. **Additionality beyond vegetation trends** (would the project have happened anyway financially?) is out of scope for remote sensing and remains a registry question.
5. **The case-study polygons are digitised from imagery** for demonstration (the placebo and boundary tests bound how much a hand-drawn line can matter): Smritivan's around the visible planted blocks, Hasdeo and Banni as hypothetical fraudulent claims. They are not registered carbon projects, and the credit figures are not certified offsets.
