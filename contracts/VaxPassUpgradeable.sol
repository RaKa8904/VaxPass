// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title VaxPassUpgradeable
 * @notice Enterprise-grade, UUPS-upgradeable cold-chain vaccine passport and dynamic expiry management.
 * @dev Implements:
 *      1. UUPS Proxy pattern with regulator-restricted upgrades.
 *      2. EIP-712 Hardware-signed telemetry verification with replay-resistant nonces.
 *      3. Salted patient commitments (keccak256(patientSecret, batchId, salt)) for zero-PII privacy.
 *      4. Multi-hop custody tracking (DAG model with UN/LOCODE / GS1 GLN location tagging & signatures).
 *      5. Dynamic thermal excursion burn-down and autonomous batch spoilage.
 */
contract VaxPassUpgradeable is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    EIP712Upgradeable
{
    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant CLINIC_ROLE = keccak256("CLINIC_ROLE");
    bytes32 public constant LOGGER_ROLE = keccak256("LOGGER_ROLE");

    uint256 public constant EXPIRY_PENALTY_FACTOR = 10; // 1 excursion minute penalizes 10 expiry minutes

    bytes32 public constant SENSOR_READING_TYPEHASH = keccak256(
        "SensorReading(uint256 batchId,int256 tempX10,uint256 durationMins,uint256 nonce,uint256 timestamp)"
    );

    enum Status {
        MANUFACTURED,
        IN_TRANSIT,
        DELIVERED,
        IN_USE,
        DEPLETED,
        SPOILED,
        RECALLED,
        EXPIRED
    }

    struct SensorReading {
        uint256 batchId;
        int256 tempX10;
        uint256 durationMins;
        uint256 nonce;
        uint256 timestamp;
    }

    struct Batch {
        uint256 id;
        string vaccineName;
        string lotNumber;
        uint256 totalDoses;
        uint256 dosesRemaining;
        uint256 manufactureTime;
        uint256 printedExpiry;
        uint256 effectiveExpiry;
        int256 minTempX10;
        int256 maxTempX10;
        uint256 excursionBudgetMins;
        uint256 excursionMinsUsed;
        address manufacturer;
        address custodian;
        address clinic;
        Status status;
        string ipfsCid;
    }

    struct CustodyHop {
        uint256 hopIndex;
        address from;
        address to;
        uint256 timestamp;
        string locationCode; // UN/LOCODE (e.g., "USNYC") or GS1 GLN (e.g., "0614141000005")
        bytes signature;     // Cryptographic proof of receipt/handover manifest
        string notes;
    }

    struct BatchHistory {
        Status status;
        address actor;
        uint256 timestamp;
        string note;
    }

    struct TemperatureLog {
        int256 tempX10;
        uint256 durationMins;
        uint256 timestamp;
        address logger;
        bool excursion;
    }

    struct Stats {
        uint256 totalBatches;
        uint256 dosesAdministered;
        uint256 spoiled;
        uint256 recalled;
        uint256 expired;
        uint256 totalExcursionMinutes;
        uint256 totalHopsRecorded;
    }

    uint256 private _nextBatchId;
    mapping(uint256 => Batch) private _batches;
    mapping(uint256 => BatchHistory[]) private _history;
    mapping(uint256 => TemperatureLog[]) private _temperatureLogs;
    mapping(uint256 => CustodyHop[]) private _custodyHops;
    mapping(uint256 => mapping(bytes32 => bool)) private _doseCommitments;
    mapping(bytes32 => uint256) private _commitmentTimestamps;
    mapping(bytes32 => address) private _commitmentClinics;

    mapping(uint256 => address) public pendingCustodian;
    mapping(uint256 => bool) public distributorConfirmed;
    mapping(uint256 => bool) public clinicConfirmed;
    mapping(address => bytes32) public requestedRole;
    mapping(address => uint256) public sensorNonces;
    Stats private _stats;

    // Events
    event RoleRequested(address indexed entity, bytes32 indexed role);
    event EntityApproved(address indexed entity, bytes32 indexed role);
    event EntityRevoked(address indexed entity, bytes32 indexed role);
    event RegulatorTransferred(address indexed previousRegulator, address indexed newRegulator);
    event BatchRegistered(uint256 indexed id, string lotNumber, address indexed manufacturer);
    event CustodyHopRecorded(
        uint256 indexed id,
        uint256 indexed hopIndex,
        address indexed from,
        address to,
        string locationCode
    );
    event CustodyTransferred(uint256 indexed id, address indexed from, address indexed to, Status status);
    event ReceiptConfirmed(uint256 indexed id, address indexed actor, bool distributorSide);
    event TelemetryVerified(uint256 indexed batchId, address indexed sensor, uint256 indexed nonce, int256 tempX10);
    event TemperatureLogged(uint256 indexed id, int256 tempX10, uint256 durationMins, bool excursion);
    event ExcursionDetected(uint256 indexed id, int256 tempX10, uint256 durationMins, uint256 expiryPenaltySeconds);
    event BatchSpoiled(uint256 indexed id, uint256 excursionMinsUsed);
    event BatchRecalled(uint256 indexed id, string reason);
    event DoseAdministeredWithCommitment(uint256 indexed id, bytes32 indexed commitment, address indexed clinic);
    event BatchExpired(uint256 indexed id);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the upgradeable contract instance.
     * @param regulator Address of the primary regulatory authority.
     */
    function initialize(address regulator) external initializer {
        require(regulator != address(0), "Invalid regulator address");
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __EIP712_init("VaxPassTelemetry", "1");

        _grantRole(DEFAULT_ADMIN_ROLE, regulator);
        _grantRole(REGULATOR_ROLE, regulator);
        _nextBatchId = 1;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(REGULATOR_ROLE) {}

    modifier batchExists(uint256 id) {
        require(_batches[id].id != 0, "Batch does not exist");
        _;
    }

    modifier onlyRegulator() {
        require(hasRole(REGULATOR_ROLE, msg.sender), "Regulator role required");
        _;
    }

    // =========================================================================
    // Role Management
    // =========================================================================

    function requestRole(bytes32 role) external {
        require(_isOperationalRole(role), "Invalid requested role");
        requestedRole[msg.sender] = role;
        emit RoleRequested(msg.sender, role);
    }

    function approveEntity(address entity, bytes32 role) external onlyRegulator {
        require(_isOperationalRole(role), "Invalid operational role");
        require(requestedRole[entity] == role, "Entity did not request this role");
        _grantRole(role, entity);
        emit EntityApproved(entity, role);
    }

    function revokeEntity(address entity, bytes32 role) external onlyRegulator {
        require(_isOperationalRole(role), "Invalid operational role");
        _revokeRole(role, entity);
        emit EntityRevoked(entity, role);
    }

    function transferRegulator(address newRegulator) external onlyRegulator {
        require(newRegulator != address(0), "Invalid regulator address");
        _grantRole(REGULATOR_ROLE, newRegulator);
        _grantRole(DEFAULT_ADMIN_ROLE, newRegulator);
        _revokeRole(REGULATOR_ROLE, msg.sender);
        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
        emit RegulatorTransferred(msg.sender, newRegulator);
    }

    // =========================================================================
    // Batch Lifecycle & Multi-Hop Custody DAG
    // =========================================================================

    function registerBatch(
        string calldata name,
        string calldata lot,
        uint256 totalDoses,
        uint256 printedExpiry,
        int256 minTempX10,
        int256 maxTempX10,
        uint256 excursionBudgetMins,
        string calldata ipfsCid
    ) external onlyRole(MANUFACTURER_ROLE) returns (uint256 id) {
        require(bytes(name).length > 0 && bytes(lot).length > 0, "Name and lot required");
        require(totalDoses > 0, "Doses must be positive");
        require(printedExpiry > block.timestamp, "Expiry must be future");
        require(minTempX10 <= maxTempX10, "Invalid temperature range");

        id = _nextBatchId++;
        _batches[id] = Batch({
            id: id,
            vaccineName: name,
            lotNumber: lot,
            totalDoses: totalDoses,
            dosesRemaining: totalDoses,
            manufactureTime: block.timestamp,
            printedExpiry: printedExpiry,
            effectiveExpiry: printedExpiry,
            minTempX10: minTempX10,
            maxTempX10: maxTempX10,
            excursionBudgetMins: excursionBudgetMins,
            excursionMinsUsed: 0,
            manufacturer: msg.sender,
            custodian: msg.sender,
            clinic: address(0),
            status: Status.MANUFACTURED,
            ipfsCid: ipfsCid
        });
        _stats.totalBatches++;
        _addHistory(id, Status.MANUFACTURED, "Batch registered by manufacturer");
        emit BatchRegistered(id, lot, msg.sender);
    }

    function dispatchTransfer(
        uint256 id,
        address nextCustodian,
        string calldata locationCode,
        string calldata notes
    ) external batchExists(id) {
        Batch storage b = _batches[id];
        require(b.custodian == msg.sender, "Only current custodian");
        require(
            hasRole(DISTRIBUTOR_ROLE, nextCustodian) || hasRole(CLINIC_ROLE, nextCustodian),
            "Invalid recipient role"
        );
        _requireNotBlocked(b);

        pendingCustodian[id] = nextCustodian;
        b.status = Status.IN_TRANSIT;
        _addHistory(id, Status.IN_TRANSIT, string(abi.encodePacked("Dispatched from ", locationCode, ": ", notes)));
        emit CustodyTransferred(id, msg.sender, nextCustodian, Status.IN_TRANSIT);
    }

    function acceptTransfer(
        uint256 id,
        string calldata locationCode,
        bytes calldata signature,
        string calldata notes
    ) external batchExists(id) {
        Batch storage b = _batches[id];
        _requireNotBlocked(b);
        require(b.status == Status.IN_TRANSIT, "Not in transit");
        require(pendingCustodian[id] == msg.sender, "Not pending");

        address previousCustodian = b.custodian;
        b.custodian = msg.sender;
        pendingCustodian[id] = address(0);

        uint256 hopIdx = _custodyHops[id].length;
        _custodyHops[id].push(CustodyHop({
            hopIndex: hopIdx,
            from: previousCustodian,
            to: msg.sender,
            timestamp: block.timestamp,
            locationCode: locationCode,
            signature: signature,
            notes: notes
        }));
        _stats.totalHopsRecorded++;

        if (hasRole(CLINIC_ROLE, msg.sender)) {
            b.clinic = msg.sender;
            b.status = Status.DELIVERED;
            _addHistory(id, Status.DELIVERED, string(abi.encodePacked("Delivered to clinic at ", locationCode)));
            emit CustodyTransferred(id, previousCustodian, msg.sender, Status.DELIVERED);
        } else {
            _addHistory(id, Status.IN_TRANSIT, string(abi.encodePacked("Hop accepted at ", locationCode)));
            emit CustodyTransferred(id, previousCustodian, msg.sender, Status.IN_TRANSIT);
        }

        emit CustodyHopRecorded(id, hopIdx, previousCustodian, msg.sender, locationCode);
    }

    function dispatchBatch(uint256 id, address distributor) external batchExists(id) {
        Batch storage b = _batches[id];
        require(b.custodian == msg.sender, "Only current custodian");
        require(b.status == Status.MANUFACTURED, "Not ready to dispatch");
        require(hasRole(DISTRIBUTOR_ROLE, distributor), "Not distributor");
        _requireNotBlocked(b);

        pendingCustodian[id] = distributor;
        b.status = Status.IN_TRANSIT;
        _addHistory(id, Status.IN_TRANSIT, "Dispatched; awaiting distributor acceptance");
        emit CustodyTransferred(id, msg.sender, distributor, Status.IN_TRANSIT);
    }

    function acceptCustody(uint256 id) external batchExists(id) onlyRole(DISTRIBUTOR_ROLE) {
        Batch storage b = _batches[id];
        require(b.status == Status.IN_TRANSIT, "Not in transit");
        require(pendingCustodian[id] == msg.sender, "Not pending");
        _requireNotBlocked(b);

        address previous = b.custodian;
        b.custodian = msg.sender;
        pendingCustodian[id] = address(0);

        uint256 hopIdx = _custodyHops[id].length;
        _custodyHops[id].push(CustodyHop({
            hopIndex: hopIdx,
            from: previous,
            to: msg.sender,
            timestamp: block.timestamp,
            locationCode: "DIST-HUB",
            signature: "",
            notes: "Distributor accepted custody"
        }));
        _stats.totalHopsRecorded++;

        _addHistory(id, Status.IN_TRANSIT, "Distributor accepted custody");
        emit CustodyHopRecorded(id, hopIdx, previous, msg.sender, "DIST-HUB");
        emit CustodyTransferred(id, previous, msg.sender, Status.IN_TRANSIT);
    }

    function deliverToClinic(uint256 id, address clinic) external batchExists(id) onlyRole(DISTRIBUTOR_ROLE) {
        Batch storage b = _batches[id];
        require(b.custodian == msg.sender, "Only custodian");
        require(b.status == Status.IN_TRANSIT, "Not in transit");
        require(hasRole(CLINIC_ROLE, clinic), "Not clinic");
        _requireNotBlocked(b);

        b.clinic = clinic;
        distributorConfirmed[id] = false;
        clinicConfirmed[id] = false;
        _addHistory(id, Status.IN_TRANSIT, "At clinic; awaiting dual confirmation");
    }

    function confirmReceipt(uint256 id) external batchExists(id) {
        Batch storage b = _batches[id];
        _requireNotBlocked(b);
        require(b.status == Status.IN_TRANSIT, "Not in transit");
        require(b.clinic != address(0), "No clinic");

        if (msg.sender == b.custodian && hasRole(DISTRIBUTOR_ROLE, msg.sender)) {
            require(!distributorConfirmed[id], "Already confirmed");
            distributorConfirmed[id] = true;
            _addHistory(id, Status.IN_TRANSIT, "Distributor confirmed handover");
            emit ReceiptConfirmed(id, msg.sender, true);
        } else if (msg.sender == b.clinic && hasRole(CLINIC_ROLE, msg.sender)) {
            require(!clinicConfirmed[id], "Already confirmed");
            clinicConfirmed[id] = true;
            _addHistory(id, Status.IN_TRANSIT, "Clinic confirmed receipt");
            emit ReceiptConfirmed(id, msg.sender, false);
        } else {
            revert("Unauthorized actor");
        }

        if (distributorConfirmed[id] && clinicConfirmed[id]) {
            address previous = b.custodian;
            b.custodian = b.clinic;
            b.status = Status.DELIVERED;

            uint256 hopIdx = _custodyHops[id].length;
            _custodyHops[id].push(CustodyHop({
                hopIndex: hopIdx,
                from: previous,
                to: b.clinic,
                timestamp: block.timestamp,
                locationCode: "CLINIC-RECEIPT",
                signature: "",
                notes: "Dual-confirmation delivery complete"
            }));
            _stats.totalHopsRecorded++;

            _addHistory(id, Status.DELIVERED, "Custody transferred to clinic");
            emit CustodyHopRecorded(id, hopIdx, previous, b.clinic, "CLINIC-RECEIPT");
            emit CustodyTransferred(id, previous, b.clinic, Status.DELIVERED);
        }
    }

    // =========================================================================
    // Hardware-Authenticated Telemetry (EIP-712 IoT Verification)
    // =========================================================================

    /**
     * @notice Submits a cryptographically authenticated telemetry packet from an IoT hardware secure element.
     * @dev Replay attacks are prevented via strict sequential nonce tracking per hardware sensor address.
     * @param reading Struct containing batchId, tempX10, durationMins, sequence nonce, and timestamp.
     * @param signature EIP-712 ECDSA signature generated inside the hardware secure element enclave.
     */
    function submitSignedTelemetry(
        SensorReading calldata reading,
        bytes calldata signature
    ) external batchExists(reading.batchId) {
        require(reading.durationMins > 0, "Duration must be positive");
        require(reading.timestamp <= block.timestamp + 1 hours, "Future telemetry timestamp");

        bytes32 structHash = keccak256(abi.encode(
            SENSOR_READING_TYPEHASH,
            reading.batchId,
            reading.tempX10,
            reading.durationMins,
            reading.nonce,
            reading.timestamp
        ));

        bytes32 digest = _hashTypedDataV4(structHash);
        address sensor = ECDSA.recover(digest, signature);

        require(hasRole(LOGGER_ROLE, sensor), "Unauthorized sensor");
        require(reading.nonce == sensorNonces[sensor], "Invalid sequence nonce");
        sensorNonces[sensor]++;

        Batch storage b = _batches[reading.batchId];
        require(
            b.status == Status.IN_TRANSIT || b.status == Status.DELIVERED,
            "Telemetry not allowed"
        );
        _requireNotBlocked(b);

        bool excursion = reading.tempX10 < b.minTempX10 || reading.tempX10 > b.maxTempX10;
        _temperatureLogs[reading.batchId].push(TemperatureLog({
            tempX10: reading.tempX10,
            durationMins: reading.durationMins,
            timestamp: reading.timestamp,
            logger: sensor,
            excursion: excursion
        }));

        emit TemperatureLogged(reading.batchId, reading.tempX10, reading.durationMins, excursion);
        emit TelemetryVerified(reading.batchId, sensor, reading.nonce, reading.tempX10);

        if (excursion) {
            b.excursionMinsUsed += reading.durationMins;
            _stats.totalExcursionMinutes += reading.durationMins;
            uint256 penalty = reading.durationMins * EXPIRY_PENALTY_FACTOR * 1 minutes;
            b.effectiveExpiry = penalty >= b.effectiveExpiry ? 0 : b.effectiveExpiry - penalty;
            emit ExcursionDetected(reading.batchId, reading.tempX10, reading.durationMins, penalty);

            if (b.excursionMinsUsed > b.excursionBudgetMins) {
                b.status = Status.SPOILED;
                _stats.spoiled++;
                _addHistory(reading.batchId, Status.SPOILED, "Excursion budget exceeded; batch spoiled");
                emit BatchSpoiled(reading.batchId, b.excursionMinsUsed);
            }
        }
    }

    function hashSensorReading(SensorReading calldata reading) public pure returns (bytes32) {
        return keccak256(abi.encode(
            SENSOR_READING_TYPEHASH,
            reading.batchId,
            reading.tempX10,
            reading.durationMins,
            reading.nonce,
            reading.timestamp
        ));
    }

    function getTelemetryDigest(SensorReading calldata reading) external view returns (bytes32) {
        return _hashTypedDataV4(hashSensorReading(reading));
    }

    /**
     * @notice Deprecated manual temperature logging.
     * @dev Telemetry must be submitted via submitSignedTelemetry with hardware EIP-712 signatures.
     */
    function logTemperature(uint256, int256, uint256) external pure {
        revert("Deprecated: Use submitSignedTelemetry with hardware EIP-712 signatures");
    }

    // =========================================================================
    // Patient Privacy: Salted Commitments & Dose Administration
    // =========================================================================

    function administerDose(uint256 id, bytes32 commitment) external batchExists(id) onlyRole(CLINIC_ROLE) {
        require(commitment != bytes32(0), "Invalid commitment digest");
        Batch storage b = _batches[id];
        require(b.custodian == msg.sender, "Only clinic custodian");
        require(b.status == Status.DELIVERED || b.status == Status.IN_USE, "Batch cannot be used");
        require(block.timestamp < b.effectiveExpiry, "Batch is expired");
        require(b.dosesRemaining > 0, "No doses remaining");
        require(!_doseCommitments[id][commitment], "Commitment already used for this batch");

        _doseCommitments[id][commitment] = true;
        _commitmentTimestamps[commitment] = block.timestamp;
        _commitmentClinics[commitment] = msg.sender;

        b.dosesRemaining--;
        _stats.dosesAdministered++;
        b.status = b.dosesRemaining == 0 ? Status.DEPLETED : Status.IN_USE;
        _addHistory(id, b.status, "Dose administered via cryptographic commitment");

        emit DoseAdministeredWithCommitment(id, commitment, msg.sender);
    }

    function computeCommitment(
        bytes32 patientSecret,
        uint256 batchId,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(patientSecret, batchId, salt));
    }

    function verifyDoseReceipt(
        uint256 id,
        bytes32 patientSecret,
        bytes32 salt
    ) external view returns (bool administered, uint256 timestamp, address clinic) {
        bytes32 commitment = computeCommitment(patientSecret, id, salt);
        return hasDoseCommitment(id, commitment);
    }

    function hasDoseCommitment(
        uint256 id,
        bytes32 commitment
    ) public view returns (bool administered, uint256 timestamp, address clinic) {
        administered = _doseCommitments[id][commitment];
        timestamp = _commitmentTimestamps[commitment];
        clinic = _commitmentClinics[commitment];
    }

    // =========================================================================
    // Safety & Verification
    // =========================================================================

    function recallBatch(uint256 id, string calldata reason) external batchExists(id) onlyRegulator {
        Batch storage b = _batches[id];
        require(b.status != Status.RECALLED, "Batch already recalled");
        require(bytes(reason).length > 0, "Recall reason required");
        b.status = Status.RECALLED;
        _stats.recalled++;
        _addHistory(id, Status.RECALLED, reason);
        emit BatchRecalled(id, reason);
    }

    function markExpired(uint256 id) external batchExists(id) {
        Batch storage b = _batches[id];
        require(!_isTerminal(b.status), "Batch already terminal");
        require(block.timestamp >= b.effectiveExpiry, "Batch has not expired");
        b.status = Status.EXPIRED;
        _stats.expired++;
        _addHistory(id, Status.EXPIRED, "Effective expiry reached");
        emit BatchExpired(id);
    }

    function getBatch(uint256 id) external view batchExists(id) returns (Batch memory) {
        return _batches[id];
    }

    function getBatchHistory(uint256 id) external view batchExists(id) returns (BatchHistory[] memory) {
        return _history[id];
    }

    function getTemperatureLogs(uint256 id) external view batchExists(id) returns (TemperatureLog[] memory) {
        return _temperatureLogs[id];
    }

    function getCustodyHops(uint256 id) external view batchExists(id) returns (CustodyHop[] memory) {
        return _custodyHops[id];
    }

    function getStats() external view returns (Stats memory) {
        return _stats;
    }

    function verifyBatch(uint256 id) external view returns (uint8 code, string memory message) {
        Batch storage b = _batches[id];
        if (b.id == 0) return (2, "Batch not found");
        if (b.status == Status.SPOILED) return (2, "Batch is spoiled");
        if (b.status == Status.RECALLED) return (2, "Batch is recalled");
        if (b.status == Status.EXPIRED || block.timestamp >= b.effectiveExpiry) return (2, "Batch is expired");
        if (b.excursionBudgetMins > 0 && b.excursionMinsUsed * 2 > b.excursionBudgetMins) {
            return (1, "More than 50% of excursion budget used");
        }
        if (b.effectiveExpiry <= block.timestamp + 7 days) return (1, "Effective expiry is within 7 days");
        return (0, "Batch is valid");
    }

    // =========================================================================
    // Internal Utilities
    // =========================================================================

    function _addHistory(uint256 id, Status status, string memory note) private {
        _history[id].push(BatchHistory(status, msg.sender, block.timestamp, note));
    }

    function _requireNotBlocked(Batch storage b) private view {
        require(
            b.status != Status.SPOILED && b.status != Status.RECALLED && b.status != Status.EXPIRED,
            "Batch is blocked"
        );
        require(block.timestamp < b.effectiveExpiry, "Batch is expired");
    }

    function _isTerminal(Status status) private pure returns (bool) {
        return status == Status.DEPLETED || status == Status.SPOILED || status == Status.RECALLED || status == Status.EXPIRED;
    }

    function _isOperationalRole(bytes32 role) private pure returns (bool) {
        return role == MANUFACTURER_ROLE || role == DISTRIBUTOR_ROLE || role == CLINIC_ROLE || role == LOGGER_ROLE;
    }

    uint256[39] private __gap;
}
