// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ProofOfForest
/// @notice Satellite-verified reforestation carbon credits.
///
/// Credits are ERC-1155 tokens. Each token id is one issuance batch (one project, one vintage).
/// Every tonne in a batch owns a unique, globally sequential serial number. Credits can only be
/// minted when at least `oracleThreshold` independent oracles sign an EIP-712 attestation of a
/// Sentinel-2 NDVI analysis AND the attested numbers satisfy the on-chain policy. Retiring burns
/// the tokens and permanently assigns a serial range to the retiree, so a tonne can never be
/// claimed twice. A share of every batch is withheld in a non-transferable buffer pool that is
/// cancelled if a later attestation shows the forest was lost (reversal).
contract ProofOfForest is ERC1155, AccessControl, Pausable, EIP712 {
    // ------------------------------------------------------------------ roles
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant POLICY_ROLE = keccak256("POLICY_ROLE");

    // ------------------------------------------------------------------ EIP-712 types
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint256 projectId,bytes32 geometryHash,bytes32 reportHash,uint16 baselineYear,uint16 monitoringYear,int32 ndviBaseline,int32 ndviMonitoring,int32 controlDelta,int32 netGain,uint32 validCoverageBps,uint32 canopyGainHa100,uint64 creditTonnes,bool passed,uint64 expiry)"
    );
    bytes32 public constant REVERSAL_TYPEHASH = keccak256(
        "Reversal(uint256 projectId,uint256 batchId,bytes32 reportHash,uint64 lostTonnes,uint64 expiry)"
    );

    /// @dev NDVI-like values are fixed point with 4 decimals (0.0512 => 512).
    struct Attestation {
        uint256 projectId;
        bytes32 geometryHash; // keccak256 of the canonical project polygon
        bytes32 reportHash; // keccak256 of the canonical verification report (published off-chain)
        uint16 baselineYear;
        uint16 monitoringYear;
        int32 ndviBaseline; // mean NDVI inside the polygon, baseline window
        int32 ndviMonitoring; // mean NDVI inside the polygon, monitoring window
        int32 controlDelta; // NDVI change of the surrounding control ring over the same windows
        int32 netGain; // (project change) - (control change): difference-in-differences
        uint32 validCoverageBps; // share of cloud-free valid pixels, worst of both windows
        uint32 canopyGainHa100; // hectares that became canopy, x100
        uint64 creditTonnes; // conservative tCO2e removal estimate (before buffer)
        bool passed; // oracle verdict
        uint64 expiry; // signature validity deadline (unix seconds)
    }

    struct Reversal {
        uint256 projectId;
        uint256 batchId;
        bytes32 reportHash;
        uint64 lostTonnes;
        uint64 expiry;
    }

    enum Outcome {
        None,
        Issued,
        RejectedByOracle,
        RejectedLowGain,
        RejectedLowCoverage,
        RejectedNoCredits
    }

    struct Project {
        address developer;
        bytes32 geometryHash;
        uint16 startYear; // baseline year fixed at registration: no cherry-picking later
        uint16 lastMonitoringYear; // crediting periods are contiguous and never overlap
        uint64 totalIssued;
        uint64 totalBuffer;
        uint64 reversedTonnes;
        uint64 bufferShortfall; // reversal not covered by buffer: blocks further issuance
        uint32 rejections;
        string name;
        string metadataURI;
    }

    struct Batch {
        uint256 projectId;
        uint16 vintage;
        uint64 serialStart; // first serial of the batch (inclusive)
        uint64 issued; // tonnes minted to the developer
        uint64 buffer; // tonnes withheld in the buffer pool
        uint64 retired; // issued tonnes retired so far (cursor into the issued range)
        uint64 cancelled; // buffer tonnes cancelled by reversals (cursor into the buffer range)
        bytes32 reportHash;
    }

    struct Retirement {
        uint256 batchId;
        address retiree;
        uint64 serialFrom; // inclusive
        uint64 serialTo; // inclusive
        uint64 timestamp;
        string beneficiary;
        string purpose;
    }

    struct VerificationRecord {
        uint256 projectId;
        bytes32 reportHash;
        uint16 baselineYear;
        uint16 monitoringYear;
        int32 netGain;
        uint32 validCoverageBps;
        uint64 creditTonnes;
        Outcome outcome;
        uint256 batchId;
        uint64 timestamp;
    }

    enum SerialStatus {
        Nonexistent,
        Outstanding,
        Retired,
        Buffer,
        Cancelled
    }

    // ------------------------------------------------------------------ policy
    uint8 public oracleThreshold;
    int32 public minNetGain; // e.g. 500 = +0.05 NDVI above the control area
    uint32 public minCoverageBps; // e.g. 8000 = 80% cloud-free pixels
    uint16 public bufferBps; // e.g. 2000 = 20% of each issuance withheld

    // ------------------------------------------------------------------ state
    Project[] internal _projects; // index 0 unused
    Batch[] internal _batches; // index 0 unused, batch id == token id
    Retirement[] internal _retirements; // index 0 unused
    VerificationRecord[] internal _verifications;
    mapping(bytes32 => uint256) public projectByGeometry;
    mapping(bytes32 => bool) public reportUsed;
    mapping(uint256 => uint256[]) internal _batchRetirements;
    mapping(uint256 => uint256[]) internal _projectBatches;
    mapping(uint256 => uint256[]) internal _projectVerifications;
    uint64 public nextSerial = 1;
    uint64 public totalRetired;

    // ------------------------------------------------------------------ events
    event ProjectRegistered(uint256 indexed projectId, address indexed developer, bytes32 geometryHash, uint16 startYear, string name);
    event VerificationRecorded(uint256 indexed projectId, uint256 indexed verificationId, bytes32 indexed reportHash, Outcome outcome, int32 netGain, uint64 creditTonnes);
    event CreditsIssued(uint256 indexed projectId, uint256 indexed batchId, uint16 vintage, uint64 serialStart, uint64 issued, uint64 buffer);
    event CreditsRetired(uint256 indexed retirementId, uint256 indexed batchId, address indexed retiree, uint64 serialFrom, uint64 serialTo, string beneficiary, string purpose);
    event ReversalRecorded(uint256 indexed projectId, uint256 indexed batchId, bytes32 reportHash, uint64 lostTonnes, uint64 cancelledFromBuffer, uint64 shortfall);
    event PolicyUpdated(uint8 oracleThreshold, int32 minNetGain, uint32 minCoverageBps, uint16 bufferBps);

    // ------------------------------------------------------------------ errors
    error UnknownProject();
    error UnknownBatch();
    error GeometryAlreadyRegistered(uint256 projectId);
    error GeometryMismatch();
    error ReportAlreadyUsed();
    error AttestationExpired();
    error InvalidCreditingPeriod();
    error NotEnoughOracleSignatures(uint256 valid, uint256 required);
    error SignersNotSorted();
    error SignerNotOracle(address signer);
    error ProjectHasBufferShortfall();
    error InvalidAmount();
    error InvalidPolicy();
    error NotAuthorized();

    constructor(address admin, address[] memory oracles, uint8 threshold, string memory uri_)
        ERC1155(uri_)
        EIP712("ProofOfForest", "1")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(POLICY_ROLE, admin);
        for (uint256 i; i < oracles.length; ++i) {
            _grantRole(ORACLE_ROLE, oracles[i]);
        }
        _projects.push();
        _batches.push();
        _retirements.push();
        _setPolicy(threshold, 500, 8000, 2000);
    }

    // ================================================================== registry

    /// @notice Register a reforestation project. The polygon hash and baseline year are locked forever.
    function registerProject(string calldata name, bytes32 geometryHash, uint16 startYear, string calldata metadataURI)
        external
        returns (uint256 projectId)
    {
        uint256 existing = projectByGeometry[geometryHash];
        if (existing != 0) revert GeometryAlreadyRegistered(existing);
        if (startYear < 2015 || geometryHash == bytes32(0)) revert InvalidCreditingPeriod();
        projectId = _projects.length;
        Project storage p = _projects.push();
        p.developer = msg.sender;
        p.geometryHash = geometryHash;
        p.startYear = startYear;
        p.lastMonitoringYear = startYear;
        p.name = name;
        p.metadataURI = metadataURI;
        projectByGeometry[geometryHash] = projectId;
        emit ProjectRegistered(projectId, msg.sender, geometryHash, startYear, name);
    }

    // ================================================================== issuance

    /// @notice Submit an oracle attestation. Anyone may relay it; credits always go to the project developer.
    /// A failed verification is recorded on-chain (public, permanent) instead of reverting.
    /// @param signatures oracle signatures over the EIP-712 digest, ordered by ascending signer address.
    function submitVerification(Attestation calldata a, bytes[] calldata signatures)
        external
        whenNotPaused
        returns (uint256 verificationId, Outcome outcome)
    {
        Project storage p = _project(a.projectId);
        if (a.geometryHash != p.geometryHash) revert GeometryMismatch();
        if (reportUsed[a.reportHash]) revert ReportAlreadyUsed();
        if (block.timestamp > a.expiry) revert AttestationExpired();
        if (a.baselineYear != p.lastMonitoringYear || a.monitoringYear <= a.baselineYear) {
            revert InvalidCreditingPeriod();
        }
        if (p.bufferShortfall != 0) revert ProjectHasBufferShortfall();
        _checkSignatures(_hashAttestation(a), signatures);
        reportUsed[a.reportHash] = true;

        // Defence in depth: the contract re-checks the attested numbers against its own policy,
        // so a compromised or buggy oracle cannot mint on weak evidence.
        if (!a.passed) outcome = Outcome.RejectedByOracle;
        else if (a.validCoverageBps < minCoverageBps) outcome = Outcome.RejectedLowCoverage;
        else if (a.netGain < minNetGain) outcome = Outcome.RejectedLowGain;
        else if (a.creditTonnes == 0) outcome = Outcome.RejectedNoCredits;
        else outcome = Outcome.Issued;

        uint256 batchId;
        if (outcome == Outcome.Issued) {
            batchId = _issue(a, p);
        } else {
            p.rejections += 1;
        }

        verificationId = _verifications.length;
        _verifications.push(
            VerificationRecord({
                projectId: a.projectId,
                reportHash: a.reportHash,
                baselineYear: a.baselineYear,
                monitoringYear: a.monitoringYear,
                netGain: a.netGain,
                validCoverageBps: a.validCoverageBps,
                creditTonnes: a.creditTonnes,
                outcome: outcome,
                batchId: batchId,
                timestamp: uint64(block.timestamp)
            })
        );
        _projectVerifications[a.projectId].push(verificationId);
        emit VerificationRecorded(a.projectId, verificationId, a.reportHash, outcome, a.netGain, a.creditTonnes);
    }

    function _issue(Attestation calldata a, Project storage p) internal returns (uint256 batchId) {
        uint64 buffer = uint64((uint256(a.creditTonnes) * bufferBps + 9_999) / 10_000); // round buffer up
        uint64 issued = a.creditTonnes - buffer;
        batchId = _batches.length;
        _batches.push(
            Batch({
                projectId: a.projectId,
                vintage: a.monitoringYear,
                serialStart: nextSerial,
                issued: issued,
                buffer: buffer,
                retired: 0,
                cancelled: 0,
                reportHash: a.reportHash
            })
        );
        nextSerial += a.creditTonnes;
        p.lastMonitoringYear = a.monitoringYear;
        p.totalIssued += issued;
        p.totalBuffer += buffer;
        _projectBatches[a.projectId].push(batchId);
        emit CreditsIssued(a.projectId, batchId, a.monitoringYear, _batches[batchId].serialStart, issued, buffer);
        if (issued > 0) _mint(p.developer, batchId, issued, "");
    }

    // ================================================================== retirement

    /// @notice Burn credits and permanently assign their serial numbers to a named beneficiary.
    function retire(uint256 batchId, uint64 amount, string calldata beneficiary, string calldata purpose)
        external
        returns (uint256 retirementId)
    {
        return _retire(msg.sender, batchId, amount, beneficiary, purpose);
    }

    /// @notice Retire on behalf of a holder that approved the caller (brokers, marketplaces).
    function retireFrom(address account, uint256 batchId, uint64 amount, string calldata beneficiary, string calldata purpose)
        external
        returns (uint256 retirementId)
    {
        if (account != msg.sender && !isApprovedForAll(account, msg.sender)) revert NotAuthorized();
        return _retire(account, batchId, amount, beneficiary, purpose);
    }

    function _retire(address account, uint256 batchId, uint64 amount, string calldata beneficiary, string calldata purpose)
        internal
        returns (uint256 retirementId)
    {
        if (amount == 0) revert InvalidAmount();
        Batch storage b = _batch(batchId);
        _burn(account, batchId, amount); // reverts if the holder does not own enough
        uint64 from = b.serialStart + b.retired;
        b.retired += amount;
        totalRetired += amount;
        retirementId = _retirements.length;
        _retirements.push(
            Retirement({
                batchId: batchId,
                retiree: account,
                serialFrom: from,
                serialTo: from + amount - 1,
                timestamp: uint64(block.timestamp),
                beneficiary: beneficiary,
                purpose: purpose
            })
        );
        _batchRetirements[batchId].push(retirementId);
        emit CreditsRetired(retirementId, batchId, account, from, from + amount - 1, beneficiary, purpose);
    }

    // ================================================================== permanence

    /// @notice Oracles attest that previously credited forest was lost (fire, clearing). The loss is cancelled
    /// from the batch's buffer; anything the buffer cannot cover is recorded as a shortfall that freezes issuance.
    function recordReversal(Reversal calldata r, bytes[] calldata signatures) external {
        Project storage p = _project(r.projectId);
        Batch storage b = _batch(r.batchId);
        if (b.projectId != r.projectId) revert UnknownBatch();
        if (reportUsed[r.reportHash]) revert ReportAlreadyUsed();
        if (block.timestamp > r.expiry) revert AttestationExpired();
        if (r.lostTonnes == 0) revert InvalidAmount();
        _checkSignatures(_hashReversal(r), signatures);
        reportUsed[r.reportHash] = true;

        uint64 available = b.buffer - b.cancelled;
        uint64 cancelled = r.lostTonnes < available ? r.lostTonnes : available;
        uint64 shortfall = r.lostTonnes - cancelled;
        b.cancelled += cancelled;
        p.totalBuffer -= cancelled;
        p.reversedTonnes += r.lostTonnes;
        p.bufferShortfall += shortfall;
        emit ReversalRecorded(r.projectId, r.batchId, r.reportHash, r.lostTonnes, cancelled, shortfall);
    }

    // ================================================================== signatures

    function hashAttestation(Attestation calldata a) external view returns (bytes32) {
        return _hashAttestation(a);
    }

    function hashReversal(Reversal calldata r) external view returns (bytes32) {
        return _hashReversal(r);
    }

    function _hashAttestation(Attestation calldata a) internal view returns (bytes32) {
        bytes memory enc = abi.encode(
            ATTESTATION_TYPEHASH,
            a.projectId,
            a.geometryHash,
            a.reportHash,
            a.baselineYear,
            a.monitoringYear,
            a.ndviBaseline,
            a.ndviMonitoring,
            a.controlDelta,
            a.netGain,
            a.validCoverageBps,
            a.canopyGainHa100,
            a.creditTonnes,
            a.passed,
            a.expiry
        );
        return _hashTypedDataV4(keccak256(enc));
    }

    function _hashReversal(Reversal calldata r) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(REVERSAL_TYPEHASH, r.projectId, r.batchId, r.reportHash, r.lostTonnes, r.expiry))
        );
    }

    /// @dev k-of-n: signers must be distinct oracles, enforced by requiring strictly ascending addresses.
    function _checkSignatures(bytes32 digest, bytes[] calldata signatures) internal view {
        address last;
        uint256 n = signatures.length;
        for (uint256 i; i < n; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= last) revert SignersNotSorted();
            if (!hasRole(ORACLE_ROLE, signer)) revert SignerNotOracle(signer);
            last = signer;
        }
        if (n < oracleThreshold) revert NotEnoughOracleSignatures(n, oracleThreshold);
    }

    // ================================================================== governance

    function setPolicy(uint8 threshold, int32 minNetGain_, uint32 minCoverageBps_, uint16 bufferBps_)
        external
        onlyRole(POLICY_ROLE)
    {
        _setPolicy(threshold, minNetGain_, minCoverageBps_, bufferBps_);
    }

    function _setPolicy(uint8 threshold, int32 minNetGain_, uint32 minCoverageBps_, uint16 bufferBps_) internal {
        if (threshold == 0 || minNetGain_ <= 0 || minCoverageBps_ > 10_000 || bufferBps_ >= 10_000) {
            revert InvalidPolicy();
        }
        oracleThreshold = threshold;
        minNetGain = minNetGain_;
        minCoverageBps = minCoverageBps_;
        bufferBps = bufferBps_;
        emit PolicyUpdated(threshold, minNetGain_, minCoverageBps_, bufferBps_);
    }

    /// @notice Emergency stop for issuance only. Retirement is never pausable: holders can always retire.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ================================================================== views

    function projectCount() external view returns (uint256) {
        return _projects.length - 1;
    }

    function batchCount() external view returns (uint256) {
        return _batches.length - 1;
    }

    function retirementCount() external view returns (uint256) {
        return _retirements.length - 1;
    }

    function verificationCount() external view returns (uint256) {
        return _verifications.length;
    }

    function getProject(uint256 projectId) external view returns (Project memory) {
        return _project(projectId);
    }

    function getBatch(uint256 batchId) external view returns (Batch memory) {
        return _batch(batchId);
    }

    function getRetirement(uint256 retirementId) external view returns (Retirement memory) {
        if (retirementId == 0 || retirementId >= _retirements.length) revert InvalidAmount();
        return _retirements[retirementId];
    }

    function getVerification(uint256 verificationId) external view returns (VerificationRecord memory) {
        return _verifications[verificationId];
    }

    function projectBatches(uint256 projectId) external view returns (uint256[] memory) {
        return _projectBatches[projectId];
    }

    function projectVerifications(uint256 projectId) external view returns (uint256[] memory) {
        return _projectVerifications[projectId];
    }

    function batchRetirements(uint256 batchId) external view returns (uint256[] memory) {
        return _batchRetirements[batchId];
    }

    /// @notice Look up any serial number: which batch it belongs to, its status, and (if retired) the retirement.
    function serialInfo(uint64 serial)
        external
        view
        returns (SerialStatus status, uint256 batchId, uint256 retirementId)
    {
        if (serial == 0 || serial >= nextSerial) return (SerialStatus.Nonexistent, 0, 0);
        // batches are created with strictly increasing serialStart: binary search
        uint256 lo = 1;
        uint256 hi = _batches.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (_batches[mid].serialStart <= serial) lo = mid;
            else hi = mid - 1;
        }
        batchId = lo;
        Batch storage b = _batches[lo];
        uint64 offset = serial - b.serialStart;
        if (offset < b.issued) {
            if (offset >= b.retired) return (SerialStatus.Outstanding, batchId, 0);
            uint256[] storage rs = _batchRetirements[batchId];
            uint256 l = 0;
            uint256 h = rs.length - 1;
            while (l < h) {
                uint256 m = (l + h + 1) / 2;
                if (_retirements[rs[m]].serialFrom <= serial) l = m;
                else h = m - 1;
            }
            return (SerialStatus.Retired, batchId, rs[l]);
        }
        uint64 bufferOffset = offset - b.issued;
        if (bufferOffset < b.cancelled) return (SerialStatus.Cancelled, batchId, 0);
        return (SerialStatus.Buffer, batchId, 0);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _project(uint256 projectId) internal view returns (Project storage) {
        if (projectId == 0 || projectId >= _projects.length) revert UnknownProject();
        return _projects[projectId];
    }

    function _batch(uint256 batchId) internal view returns (Batch storage) {
        if (batchId == 0 || batchId >= _batches.length) revert UnknownBatch();
        return _batches[batchId];
    }
}
