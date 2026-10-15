// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title VaxPass - a teaching-focused cold-chain vaccine passport
/// @notice Patient identities never enter this contract: only one-way hashes are recorded.
contract VaxPass is AccessControl {
    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant CLINIC_ROLE = keccak256("CLINIC_ROLE");
    bytes32 public constant LOGGER_ROLE = keccak256("LOGGER_ROLE");

    uint256 public constant EXPIRY_PENALTY_FACTOR = 10; // one excursion minute removes ten expiry minutes

    enum Status { MANUFACTURED, IN_TRANSIT, DELIVERED, IN_USE, DEPLETED, SPOILED, RECALLED, EXPIRED }

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
    }

    uint256 private _nextBatchId = 1;
    mapping(uint256 => Batch) private _batches;
    mapping(uint256 => BatchHistory[]) private _history;
    mapping(uint256 => TemperatureLog[]) private _temperatureLogs;
    mapping(uint256 => mapping(bytes32 => bool)) private _patientTreated;
    mapping(uint256 => address) public pendingCustodian;
    mapping(uint256 => bool) public distributorConfirmed;
    mapping(uint256 => bool) public clinicConfirmed;
    mapping(address => bytes32) public requestedRole;
    Stats private _stats;

    event RoleRequested(address indexed entity, bytes32 indexed role);
    event EntityApproved(address indexed entity, bytes32 indexed role);
    event EntityRevoked(address indexed entity, bytes32 indexed role);
    event RegulatorTransferred(address indexed previousRegulator, address indexed newRegulator);
    event BatchRegistered(uint256 indexed id, string lotNumber, address indexed manufacturer);
    event CustodyTransferred(uint256 indexed id, address indexed from, address indexed to, Status status);
    event ReceiptConfirmed(uint256 indexed id, address indexed actor, bool distributorSide);
    event TemperatureLogged(uint256 indexed id, int256 tempX10, uint256 durationMins, bool excursion);
    event ExcursionDetected(uint256 indexed id, int256 tempX10, uint256 durationMins, uint256 expiryPenaltySeconds);
    event BatchSpoiled(uint256 indexed id, uint256 excursionMinsUsed);
    event BatchRecalled(uint256 indexed id, string reason);
    event DoseAdministered(uint256 indexed id, bytes32 indexed patientHash, address indexed clinic);
    event BatchExpired(uint256 indexed id);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGULATOR_ROLE, msg.sender);
    }

    modifier batchExists(uint256 id) {
        require(_batches[id].id != 0, "Batch does not exist");
        _;
    }

    modifier onlyRegulator() {
        require(hasRole(REGULATOR_ROLE, msg.sender), "Regulator role required");
        _;
    }

    /// @notice An organisation asks the regulator to approve one operational role.
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

    /// @notice Transfers the regulator capability to another account.
    function transferRegulator(address newRegulator) external onlyRegulator {
        require(newRegulator != address(0), "Invalid regulator");
        _grantRole(REGULATOR_ROLE, newRegulator);
        _grantRole(DEFAULT_ADMIN_ROLE, newRegulator);
        _revokeRole(REGULATOR_ROLE, msg.sender);
        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
        emit RegulatorTransferred(msg.sender, newRegulator);
    }

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
            id: id, vaccineName: name, lotNumber: lot, totalDoses: totalDoses, dosesRemaining: totalDoses,
            manufactureTime: block.timestamp, printedExpiry: printedExpiry, effectiveExpiry: printedExpiry,
            minTempX10: minTempX10, maxTempX10: maxTempX10, excursionBudgetMins: excursionBudgetMins,
            excursionMinsUsed: 0, manufacturer: msg.sender, custodian: msg.sender, clinic: address(0),
            status: Status.MANUFACTURED, ipfsCid: ipfsCid
        });
        _stats.totalBatches++;
        _addHistory(id, Status.MANUFACTURED, "Batch registered");
        emit BatchRegistered(id, lot, msg.sender);
    }

    function dispatchBatch(uint256 id, address distributor) external batchExists(id) {
        Batch storage b = _batches[id];
        require(b.custodian == msg.sender, "Only current custodian");
        require(b.status == Status.MANUFACTURED, "Batch is not ready to dispatch");
        require(hasRole(DISTRIBUTOR_ROLE, distributor), "Distributor not approved");
        _requireNotBlocked(b);
        pendingCustodian[id] = distributor;
        b.status = Status.IN_TRANSIT;
        _addHistory(id, Status.IN_TRANSIT, "Dispatched; awaiting distributor acceptance");
        emit CustodyTransferred(id, msg.sender, distributor, Status.IN_TRANSIT);
    }

    function acceptCustody(uint256 id) external batchExists(id) onlyRole(DISTRIBUTOR_ROLE) {
        Batch storage b = _batches[id];
        require(b.status == Status.IN_TRANSIT, "Batch is not in transit");
        require(pendingCustodian[id] == msg.sender, "Not pending distributor");
        address previous = b.custodian;
        b.custodian = msg.sender;
        pendingCustodian[id] = address(0);
        _addHistory(id, Status.IN_TRANSIT, "Distributor accepted custody");
        emit CustodyTransferred(id, previous, msg.sender, Status.IN_TRANSIT);
    }

    function deliverToClinic(uint256 id, address clinic) external batchExists(id) onlyRole(DISTRIBUTOR_ROLE) {
        Batch storage b = _batches[id];
        require(b.custodian == msg.sender, "Only distributor custodian");
        require(b.status == Status.IN_TRANSIT, "Batch is not in transit");
        require(hasRole(CLINIC_ROLE, clinic), "Clinic not approved");
        _requireNotBlocked(b);
        b.clinic = clinic;
        distributorConfirmed[id] = false;
        clinicConfirmed[id] = false;
        _addHistory(id, Status.IN_TRANSIT, "At clinic; awaiting dual confirmation");
    }

    /// @notice Called once by the distributor and once by the selected clinic.
    function confirmReceipt(uint256 id) external batchExists(id) {
        Batch storage b = _batches[id];
        _requireNotBlocked(b);
        require(b.status == Status.IN_TRANSIT, "Batch is not awaiting receipt");
        require(b.clinic != address(0), "Clinic not assigned");
        if (msg.sender == b.custodian && hasRole(DISTRIBUTOR_ROLE, msg.sender)) {
            require(!distributorConfirmed[id], "Distributor already confirmed");
            distributorConfirmed[id] = true;
            _addHistory(id, Status.IN_TRANSIT, "Distributor confirmed handover");
            emit ReceiptConfirmed(id, msg.sender, true);
        } else if (msg.sender == b.clinic && hasRole(CLINIC_ROLE, msg.sender)) {
            require(!clinicConfirmed[id], "Clinic already confirmed");
            clinicConfirmed[id] = true;
            _addHistory(id, Status.IN_TRANSIT, "Clinic confirmed receipt");
            emit ReceiptConfirmed(id, msg.sender, false);
        } else {
            revert("Only assigned distributor or clinic");
        }
        if (distributorConfirmed[id] && clinicConfirmed[id]) {
            address previous = b.custodian;
            b.custodian = b.clinic;
            b.status = Status.DELIVERED;
            _addHistory(id, Status.DELIVERED, "Custody transferred to clinic");
            emit CustodyTransferred(id, previous, b.clinic, Status.DELIVERED);
        }
    }

    function logTemperature(uint256 id, int256 tempX10, uint256 durationMins)
        external batchExists(id) onlyRole(LOGGER_ROLE)
    {
        Batch storage b = _batches[id];
        require(b.status == Status.IN_TRANSIT || b.status == Status.DELIVERED, "Temperature logging not allowed now");
        require(durationMins > 0, "Duration must be positive");
        _requireNotBlocked(b);
        bool excursion = tempX10 < b.minTempX10 || tempX10 > b.maxTempX10;
        _temperatureLogs[id].push(TemperatureLog(tempX10, durationMins, block.timestamp, msg.sender, excursion));
        emit TemperatureLogged(id, tempX10, durationMins, excursion);
        if (excursion) {
            b.excursionMinsUsed += durationMins;
            _stats.totalExcursionMinutes += durationMins;
            uint256 penalty = durationMins * EXPIRY_PENALTY_FACTOR * 1 minutes;
            b.effectiveExpiry = penalty >= b.effectiveExpiry ? 0 : b.effectiveExpiry - penalty;
            emit ExcursionDetected(id, tempX10, durationMins, penalty);
            if (b.excursionMinsUsed > b.excursionBudgetMins) {
                b.status = Status.SPOILED;
                _stats.spoiled++;
                _addHistory(id, Status.SPOILED, "Excursion budget exceeded; batch spoiled");
                emit BatchSpoiled(id, b.excursionMinsUsed);
            }
        }
    }

    function administerDose(uint256 id, bytes32 patientHash) external batchExists(id) onlyRole(CLINIC_ROLE) {
        Batch storage b = _batches[id];
        require(b.custodian == msg.sender, "Only clinic custodian");
        require(b.status == Status.DELIVERED || b.status == Status.IN_USE, "Batch cannot be used");
        require(block.timestamp < b.effectiveExpiry, "Batch is expired");
        require(b.dosesRemaining > 0, "No doses remaining");
        require(!_patientTreated[id][patientHash], "Patient already recorded for this batch");
        _patientTreated[id][patientHash] = true;
        b.dosesRemaining--;
        _stats.dosesAdministered++;
        b.status = b.dosesRemaining == 0 ? Status.DEPLETED : Status.IN_USE;
        _addHistory(id, b.status, "Dose administered (patient hash only)");
        emit DoseAdministered(id, patientHash, msg.sender);
    }

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

    function getBatch(uint256 id) external view batchExists(id) returns (Batch memory) { return _batches[id]; }
    function getBatchHistory(uint256 id) external view batchExists(id) returns (BatchHistory[] memory) { return _history[id]; }
    function getTemperatureLogs(uint256 id) external view batchExists(id) returns (TemperatureLog[] memory) { return _temperatureLogs[id]; }
    function getStats() external view returns (Stats memory) { return _stats; }

    /// @return code 0 VALID, 1 WARNING, 2 INVALID
    function verifyBatch(uint256 id) external view returns (uint8 code, string memory message) {
        Batch storage b = _batches[id];
        if (b.id == 0) return (2, "Batch not found");
        if (b.status == Status.SPOILED) return (2, "Batch is spoiled");
        if (b.status == Status.RECALLED) return (2, "Batch is recalled");
        if (b.status == Status.EXPIRED || block.timestamp >= b.effectiveExpiry) return (2, "Batch is expired");
        if (b.excursionBudgetMins > 0 && b.excursionMinsUsed * 2 > b.excursionBudgetMins) return (1, "More than 50% of excursion budget used");
        if (b.effectiveExpiry <= block.timestamp + 7 days) return (1, "Effective expiry is within 7 days");
        return (0, "Batch is valid");
    }

    function _addHistory(uint256 id, Status status, string memory note) private {
        _history[id].push(BatchHistory(status, msg.sender, block.timestamp, note));
    }

    function _requireNotBlocked(Batch storage b) private view {
        require(b.status != Status.SPOILED && b.status != Status.RECALLED && b.status != Status.EXPIRED, "Batch is blocked");
        require(block.timestamp < b.effectiveExpiry, "Batch is expired");
    }

    function _isTerminal(Status status) private pure returns (bool) {
        return status == Status.DEPLETED || status == Status.SPOILED || status == Status.RECALLED || status == Status.EXPIRED;
    }

    function _isOperationalRole(bytes32 role) private pure returns (bool) {
        return role == MANUFACTURER_ROLE || role == DISTRIBUTOR_ROLE || role == CLINIC_ROLE || role == LOGGER_ROLE;
    }
}
