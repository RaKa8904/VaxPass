// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockPaymaster
 * @notice ERC-4337 Gasless Paymaster & Sponsorship Simulator for VaxPass Enterprise.
 * @dev Implements the ERC-4337 IPaymaster specification for bundlers (Stackup, Alto, Biconomy,
 *      Pimlico) while also providing direct sponsorship execution for local Hardhat testing.
 *      Enables warehouse drivers, couriers, and clinic nurses to interact with zero native gas.
 */
contract MockPaymaster is Ownable {
    // ERC-4337 UserOperation struct
    struct UserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        uint256 callGasLimit;
        uint256 verificationGasLimit;
        uint256 preVerificationGas;
        uint256 maxFeePerGas;
        uint256 maxPriorityFeePerGas;
        bytes paymasterAndData;
        bytes signature;
    }

    enum PostOpMode {
        opSucceeded,
        opReverted,
        postOpReverted
    }

    event GasSponsored(address indexed userAccount, address indexed target, uint256 actualGasCost);
    event SponsorFunded(address indexed funder, uint256 amount);
    event UserOpValidated(bytes32 indexed userOpHash, address indexed sender, uint256 maxCost);
    event GasRefunded(address indexed recipient, uint256 amount);

    uint256 public totalGasSponsored;
    mapping(address => uint256) public sponsoredPerAccount;

    constructor() Ownable(msg.sender) {}

    receive() external payable {
        emit SponsorFunded(msg.sender, msg.value);
    }

    /**
     * @notice Funds the Paymaster sponsorship pool.
     */
    function deposit() external payable {
        emit SponsorFunded(msg.sender, msg.value);
    }

    /**
     * @notice Returns the total available sponsorship deposit.
     */
    function getDeposit() external view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice ERC-4337 Standard Paymaster validation.
     * @dev Called by the ERC-4337 EntryPoint before executing a UserOperation.
     */
    function validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData) {
        require(address(this).balance >= maxCost, "Paymaster: insufficient gas sponsorship deposit");
        emit UserOpValidated(userOpHash, userOp.sender, maxCost);
        // validationData = 0 indicates valid signature and no time range restrictions
        return (abi.encode(userOp.sender, maxCost), 0);
    }

    /**
     * @notice ERC-4337 Standard Post-Operation callback.
     * @dev Called by the ERC-4337 EntryPoint after executing a UserOperation.
     */
    function postOp(
        PostOpMode /* mode */,
        bytes calldata context,
        uint256 actualGasCost
    ) external {
        (address sender, ) = abi.decode(context, (address, uint256));
        totalGasSponsored += actualGasCost;
        sponsoredPerAccount[sender] += actualGasCost;
        emit GasSponsored(sender, msg.sender, actualGasCost);
    }

    /**
     * @notice Direct relay execution for local Hardhat testing.
     * @param target VaxPass contract address.
     * @param data Encoded calldata.
     * @param userOpSender User's Smart Account or courier address.
     */
    function executeSponsored(
        address target,
        bytes calldata data,
        address userOpSender
    ) external payable returns (bool success, bytes memory returnData) {
        uint256 startGas = gasleft();
        (success, returnData) = target.call(data);
        require(success, "Sponsored execution reverted");

        uint256 gasUsed = startGas - gasleft();
        totalGasSponsored += gasUsed;
        sponsoredPerAccount[userOpSender] += gasUsed;
        emit GasSponsored(userOpSender, target, gasUsed);
    }

    /**
     * @notice Refunds gas to a relayer or bundler from the sponsorship pool.
     */
    function refundGas(address payable recipient, uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "Insufficient deposit for refund");
        recipient.transfer(amount);
        emit GasRefunded(recipient, amount);
    }

    /**
     * @notice Emergency withdrawal by contract owner.
     */
    function withdraw(address payable recipient, uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "Insufficient deposit");
        recipient.transfer(amount);
    }
}
